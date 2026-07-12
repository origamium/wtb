/**
 * @fileoverview Git Worktree 操作
 * Git worktreeの作成、削除、一覧表示等の操作を担当
 */

import { existsSync, readFileSync } from "node:fs"
import { realpathSync } from "node:fs"
import * as path from "node:path"
import type { WorktreeInfo } from "../../types/index.js"
import { execGitSafe } from "../../utils/exec.js"
import { atomicWriteFileSync } from "../../utils/atomic-file.js"
import { out } from "../../utils/output.js"
import { isGitRepository } from "./repository.js"

/**
 * worktree 内の追跡ファイルを git の skip-worktree に設定する (best-effort)。
 *
 * wtb は worktree ごとに docker-compose.yml や調整済み env ファイルを書き換える。
 * これらが git 追跡ファイル (`git worktree add` で checkout 済み) の場合、書き換えは
 * worktree を "dirty" にしてしまい、(1) `wtb remove` の `git status --porcelain`
 * dirty チェックを誤発火させ、(2) `git worktree remove` を拒否させ、(3) ユーザーの
 * `git status` を汚し、worktree 固有の書き換え (例: project 名サフィックス) を誤って
 * ブランチへコミットさせる危険がある。skip-worktree を立てると git はその追跡ファイルの
 * ローカル変更を無視する。
 *
 * 未追跡ファイル / 非 git / 失敗時は何もしない (best-effort)。
 *
 * @param relativePath - worktree ルートからの相対パス (例: config.docker_compose_file)
 * @param cwd - worktree のパス
 */
export function markSkipWorktreeIfTracked(relativePath: string, cwd: string): boolean {
  try {
    // 追跡されているファイルのみ対象。未追跡だと ls-files が非ゼロ終了して catch される。
    execGitSafe(["ls-files", "--error-unmatch", "--", relativePath], { cwd })
  } catch {
    return false
  }
  try {
    execGitSafe(["update-index", "--skip-worktree", "--", relativePath], { cwd })
    return true
  } catch {
    return false
  }
}

/**
 * worktree ごとの "wtb が書き換えた追跡ファイル" を記録するマニフェストの内容型。
 * key は worktree ルートからの相対パス、value は wtb が書き込んだ直後の git blob sha。
 */
export type WtbManagedManifest = Record<string, string>

/** Current on-disk format. The loader also accepts the legacy flat map. */
interface VersionedWtbManagedManifest {
  version: 1
  files: WtbManagedManifest
}

const WTB_MANAGED_MANIFEST_VERSION = 1 as const

/**
 * worktree の追跡ファイルが git にどう見えるかの blob sha を返す (`git hash-object`)。
 * 未追跡 / 失敗時は null。
 */
export function gitHashObject(cwd: string, relativePath: string): string | null {
  try {
    return execGitSafe(["hash-object", "--", relativePath], { cwd }).trim()
  } catch {
    return null
  }
}

/**
 * worktree の PRIVATE git ディレクトリ内 (`.git/worktrees/<name>/`) のマニフェストパスを
 * 解決する。`git worktree remove` がこのディレクトリごと自動削除するので、wtb 側で
 * クリーンアップする必要はない。`rev-parse --git-path` の結果が相対パスなら cwd 起点で
 * 絶対化する。解決できなければ null。
 */
function resolveManifestPath(cwd: string): string | null {
  try {
    const raw = execGitSafe(["rev-parse", "--git-path", "wtb-managed.json"], { cwd }).trim()
    if (!raw) return null
    return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw)
  } catch {
    return null
  }
}

/**
 * 追跡ファイルに skip-worktree を立て、書き込んだ直後の blob sha をマニフェストへ記録する。
 *
 * skip-worktree だけだとユーザーの実編集も隠れてしまい、`wtb remove` の dirty チェックが
 * 誤って通過してユーザー編集ごと worktree を消す (データ損失) 危険がある。そこで wtb の
 * 出力 sha を記録しておき、remove 側は「マニフェストの sha と一致する managed ファイル」
 * だけを dirty 判定から除外し、ユーザーが手編集したファイルは dirty として保護する。
 *
 * 未追跡なら管理不要として true、manifest/index 更新に失敗したら false を返す。
 * 呼び出し側は false を setup failure として扱い、作成済み worktree 自体は保持できる。
 *
 * @param cwd - worktree のパス
 * @param relativePath - worktree ルートからの相対パス
 */
export function markWtbManagedFile(cwd: string, relativePath: string): boolean {
  let tracked: boolean
  try {
    // `--error-unmatch` だと「未追跡」と「Git I/O失敗」が同じ例外になる。
    // NUL形式の出力有無で未追跡を正常系として区別する。
    tracked = execGitSafe(["ls-files", "-z", "--", relativePath], { cwd }).length > 0
  } catch {
    return false
  }
  if (!tracked) return true // 未追跡 → skip-worktree も manifest 記録も不要

  // 先に manifest へ sha を記録し、成功したときだけ skip-worktree を立てる。逆順だと、
  // manifest 記録に失敗した場合にファイルが skip-worktree で隠れるのに manifest には無い
  // = `wtb remove` の dirty チェックが検出できず、ユーザー編集ごと worktree を消す穴になる。
  // 記録できなければ skip-worktree を立てない (= git status に見える fail-safe に倒す)。
  if (!recordWtbManagedFile(cwd, relativePath)) return false

  try {
    execGitSafe(["update-index", "--skip-worktree", "--", relativePath], { cwd })
    return true
  } catch {
    return false
  }
}

/**
 * wtb が書き換えた追跡ファイルの現在の blob sha をマニフェストへ read-merge-write する。
 * 追跡ファイルでない / 解決失敗 / 書き込み失敗時は false を返す (呼び出し側が
 * skip-worktree を立てるかの判断に使う)。
 */
export function recordWtbManagedFile(cwd: string, relativePath: string): boolean {
  const sha = gitHashObject(cwd, relativePath)
  if (sha === null) return false

  const manifestPath = resolveManifestPath(cwd)
  if (!manifestPath) return false

  try {
    const manifest = loadWtbManagedManifest(cwd)
    manifest[relativePath] = sha
    const document: VersionedWtbManagedManifest = {
      version: WTB_MANAGED_MANIFEST_VERSION,
      files: manifest,
    }
    atomicWriteFileSync(manifestPath, `${JSON.stringify(document, null, 2)}\n`)
    return true
  } catch {
    // best-effort: 記録できなくても worktree は使える
    return false
  }
}

/**
 * worktree のマニフェストを読み出す。存在しない場合だけ空オブジェクトを返す。
 *
 * 読み取り不能・壊れた JSON・未知の version・不正な path/value は例外にする。
 * remove がこれを空として扱うと、skip-worktree に隠れたユーザー変更を見落として
 * worktree ごと削除し得るため、破損時は fail-closed に倒す。
 */
export function loadWtbManagedManifest(cwd: string): WtbManagedManifest {
  const manifestPath = resolveManifestPath(cwd)
  if (!manifestPath) {
    throw new Error("Cannot resolve the wtb-managed manifest path")
  }
  if (!existsSync(manifestPath)) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch (error) {
    throw new Error(
      `Invalid wtb-managed manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid wtb-managed manifest at ${manifestPath}: expected an object`)
  }

  let files: Record<string, unknown>
  if (typeof parsed.version === "number" && isRecord(parsed.files)) {
    if (parsed.version !== WTB_MANAGED_MANIFEST_VERSION || !isRecord(parsed.files)) {
      throw new Error(
        `Invalid wtb-managed manifest at ${manifestPath}: unsupported version or invalid files map`
      )
    }
    files = parsed.files
  } else {
    // v0 / legacy: { "relative/path": "blob-sha", ... }
    files = parsed
  }

  const result: WtbManagedManifest = {}
  const normalized = new Set<string>()
  for (const [relativePath, sha] of Object.entries(files)) {
    if (!isSafeManagedRelativePath(relativePath) || typeof sha !== "string" || sha.length === 0) {
      throw new Error(
        `Invalid wtb-managed manifest at ${manifestPath}: invalid file entry '${relativePath}'`
      )
    }
    const normalizedPath = path.normalize(relativePath).replace(/^\.\//, "")
    if (normalized.has(normalizedPath)) {
      throw new Error(
        `Invalid wtb-managed manifest at ${manifestPath}: duplicate normalized path '${normalizedPath}'`
      )
    }
    normalized.add(normalizedPath)
    result[relativePath] = sha
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isSafeManagedRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes("\0") || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return false
  }
  if (value.split(/[\\/]+/).some((segment) => segment === "..")) return false
  const normalized = path.normalize(value)
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    return false
  }
  const segments = normalized.split(path.sep).filter((segment) => segment !== ".")
  return segments.length > 0 && !segments.some((segment) => segment.toLowerCase() === ".git")
}

/**
 * 追跡ファイルの skip-worktree を解除する (`git update-index --no-skip-worktree`)。
 * remove 側で managed ファイルの真の状態を `git status` に surface させるために使う。
 * best-effort (失敗は無視)。
 */
export function clearSkipWorktree(cwd: string, relativePath: string): boolean {
  try {
    execGitSafe(["update-index", "--no-skip-worktree", "--", relativePath], { cwd })
    return true
  } catch {
    return false
  }
}

/**
 * worktree の index で skip-worktree が立っている全 tracked path を列挙する。
 *
 * `git status` は skip-worktree path の実変更を隠すため、remove が managed manifest
 * だけを信用すると、manifest の欠落・一部欠落時にユーザー編集ごと worktree を削除し得る。
 * `git ls-files -v` の大文字 `S` tag を NUL 形式で読み、manifest が全件を説明できるかを
 * destructive cleanup 前に検証するために使う。`-v` の小文字 tag は種類を問わず
 * assume-unchanged が立っていることを示す。`h` は status から変更を隠し、`s` は
 * skip-worktree を解除しても assume-unchanged が残るため、manifest に path があっても
 * 安全に dirty 判定できない。従って小文字 tag は列挙段階で一律 fail-closed にする。
 *
 * 列挙失敗や予期しない Git 出力は空集合として扱わず例外にする。呼び出し側は
 * fail-closed に削除を拒否しなければならない。
 */
export function listSkipWorktreePaths(cwd: string): string[] {
  const output = execGitSafe(["ls-files", "-v", "-z", "--"], {
    cwd,
    preserveLeadingWhitespace: true,
  })
  const result: string[] = []

  for (const record of output.split("\0")) {
    if (record.length === 0) continue
    if (record.length < 3 || record[1] !== " ") {
      throw new Error("Unexpected output from 'git ls-files -v -z'")
    }
    const relativePath = record.slice(2)
    if (!isSafeManagedRelativePath(relativePath)) {
      throw new Error(`Unsafe tracked path returned by Git: '${relativePath}'`)
    }

    const tag = record[0]
    if (tag !== tag.toUpperCase()) {
      throw new Error(
        `Tracked path '${relativePath}' has assume-unchanged set; its changes cannot be inspected safely`
      )
    }
    if (tag !== "S") continue
    result.push(relativePath)
  }

  return result
}

/**
 * 2 つのパスが同じ場所を指すかを canonical 比較で判定する。
 *
 * git は `rev-parse --show-toplevel` と `worktree list` で、片方を symlink 解決済み、
 * 片方を未解決の形で返すことがある。素朴な文字列等価ではガード(例: main repo の
 * 削除防止)を symlink 経由で回避できてしまうため、realpath で正規化して比較する。
 * realpath が失敗(存在しない等)した場合は path.resolve にフォールバックする。
 */
export function isSamePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b)
}

/**
 * パスを canonical 形式 (realpath、失敗時は path.resolve) に正規化する。
 *
 * isSamePath と同じ根拠: git が返すパスは symlink 解決済み/未解決が混在するため、
 * プレフィックス比較 (cwd がどの worktree 配下か) にも正規化が必要。
 */
export function canonicalPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * Git worktreeの一覧を取得
 *
 * @param cwd - 対象ディレクトリ（デフォルト: 現在のディレクトリ）
 * @returns worktreeの情報配列
 * @throws {Error} Gitリポジトリではない場合
 */
export function listWorktrees(cwd?: string): WorktreeInfo[] {
  if (!isGitRepository(cwd)) {
    throw new Error("Not in a Git repository")
  }

  try {
    const output = execGitSafe(["worktree", "list", "--porcelain"], { cwd })
    return parseWorktreeList(output)
  } catch {
    return []
  }
}

/**
 * git worktree listの出力をパースしてオブジェクト配列に変換
 *
 * @param output - git worktree list --porcelainの出力
 * @returns パースされたworktree情報配列
 */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  if (!output.trim()) {
    return []
  }

  const worktrees: WorktreeInfo[] = []
  const lines = output.split("\n")
  let currentWorktree: Partial<WorktreeInfo> = {}

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      if (currentWorktree.path) {
        worktrees.push(currentWorktree as WorktreeInfo)
      }
      currentWorktree = {
        path: line.substring(9).trim(),
        branch: "",
        head: "",
      }
    } else if (line.startsWith("HEAD ")) {
      currentWorktree.head = line.substring(5).trim()
    } else if (line.startsWith("branch ")) {
      const branchRef = line.substring(7).trim()
      currentWorktree.branch = branchRef.replace("refs/heads/", "")
    } else if (line.startsWith("detached")) {
      currentWorktree.branch = "(detached)"
      currentWorktree.detached = true
    } else if (line === "locked" || line.startsWith("locked ")) {
      currentWorktree.locked = true
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      currentWorktree.prunable = true
    } else if (line === "bare") {
      currentWorktree.bare = true
    }
  }

  if (currentWorktree.path) {
    worktrees.push(currentWorktree as WorktreeInfo)
  }

  return worktrees
}

/**
 * 新しいworktreeを作成
 *
 * @param branchName - 作成するブランチ名
 * @param worktreePath - worktreeを作成するパス
 * @param options - オプション
 *   - cwd: 作業ディレクトリ
 *   - useExistingBranch: 既存ブランチを使用（新規作成しない）
 *   - baseBranch: 新規ブランチ作成時のベースブランチ名
 *   - trackFrom: remote-only ブランチを checkout する際の上流 (例: "origin/feature/x")。
 *     指定時は baseBranch ではなくこの ref からトラッキングブランチを作る。
 * @throws {Error} 作成に失敗した場合
 */
export function createWorktree(
  branchName: string,
  worktreePath: string,
  options?: { cwd?: string; useExistingBranch?: boolean; baseBranch?: string; trackFrom?: string }
): void {
  const cwd = options?.cwd
  const useExistingBranch = options?.useExistingBranch ?? false
  const baseBranch = options?.baseBranch
  const trackFrom = options?.trackFrom

  if (!isGitRepository(cwd)) {
    throw new Error("Not in a Git repository")
  }

  const args = useExistingBranch
    ? // --end-of-options: `-` 始まりのブランチ名がフラグとして解釈されるのを防ぐ
      ["worktree", "add", worktreePath, "--end-of-options", branchName]
    : trackFrom
      ? ["worktree", "add", worktreePath, "-b", branchName, "--track", trackFrom]
      : baseBranch
        ? ["worktree", "add", worktreePath, "-b", branchName, baseBranch]
        : ["worktree", "add", worktreePath, "-b", branchName]

  try {
    execGitSafe(args, { cwd })
    out(`✅ Created worktree: ${branchName} at ${worktreePath}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to create worktree: ${message}`)
  }
}

/**
 * worktreeを削除
 *
 * @param worktreePath - 削除するworktreeのパス
 * @param options - オプション（cwd: 作業ディレクトリ, force: 強制削除）
 * @throws {Error} 削除に失敗した場合
 */
export function removeWorktree(
  worktreePath: string,
  options?: { cwd?: string; force?: boolean }
): void {
  const cwd = options?.cwd
  const force = options?.force ?? false

  if (!isGitRepository(cwd)) {
    throw new Error("Not in a Git repository")
  }

  const args = force
    ? ["worktree", "remove", "--force", worktreePath]
    : ["worktree", "remove", worktreePath]

  try {
    execGitSafe(args, { cwd })
    out(`✅ Removed worktree at: ${worktreePath}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to remove worktree: ${message}`)
  }
}

/**
 * 指定されたブランチのworktreeパスを取得
 *
 * @param branchName - 検索するブランチ名
 * @param cwd - 対象ディレクトリ（デフォルト: 現在のディレクトリ）
 * @returns worktreeのパス（見つからない場合はnull）
 */
export function getWorktreePath(branchName: string, cwd?: string): string | null {
  const worktrees = listWorktrees(cwd)
  const worktree = worktrees.find((wt) => wt.branch === branchName)
  return worktree ? worktree.path : null
}
