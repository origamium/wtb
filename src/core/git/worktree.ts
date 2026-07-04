/**
 * @fileoverview Git Worktree 操作
 * Git worktreeの作成、削除、一覧表示等の操作を担当
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { realpathSync } from "node:fs"
import * as path from "node:path"
import type { WorktreeInfo } from "../../types/index.js"
import { execGitSafe } from "../../utils/exec.js"
import { out } from "../../utils/output.js"
import { getGitRoot, isGitRepository } from "./repository.js"

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
export function markSkipWorktreeIfTracked(relativePath: string, cwd: string): void {
  try {
    // 追跡されているファイルのみ対象。未追跡だと ls-files が非ゼロ終了して catch される。
    execGitSafe(["ls-files", "--error-unmatch", "--", relativePath], { cwd })
  } catch {
    return // 未追跡 → skip-worktree 不要
  }
  try {
    execGitSafe(["update-index", "--skip-worktree", "--", relativePath], { cwd })
  } catch {
    // best-effort: 設定できなくても worktree 作成自体は続行する
  }
}

/**
 * worktree ごとの "wtb が書き換えた追跡ファイル" を記録するマニフェストの内容型。
 * key は worktree ルートからの相対パス、value は wtb が書き込んだ直後の git blob sha。
 */
export type WtbManagedManifest = Record<string, string>

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
 * 未追跡 / 非 git / 失敗は best-effort で握りつぶす (worktree 作成自体は続行)。
 *
 * @param cwd - worktree のパス
 * @param relativePath - worktree ルートからの相対パス
 */
export function markWtbManagedFile(cwd: string, relativePath: string): void {
  let tracked = true
  try {
    execGitSafe(["ls-files", "--error-unmatch", "--", relativePath], { cwd })
  } catch {
    tracked = false
  }
  if (!tracked) return // 未追跡 → skip-worktree も manifest 記録も不要

  // 先に manifest へ sha を記録し、成功したときだけ skip-worktree を立てる。逆順だと、
  // manifest 記録に失敗した場合にファイルが skip-worktree で隠れるのに manifest には無い
  // = `wtb remove` の dirty チェックが検出できず、ユーザー編集ごと worktree を消す穴になる。
  // 記録できなければ skip-worktree を立てない (= git status に見える fail-safe に倒す)。
  if (!recordWtbManagedFile(cwd, relativePath)) return

  try {
    execGitSafe(["update-index", "--skip-worktree", "--", relativePath], { cwd })
  } catch {
    // best-effort
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
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    return true
  } catch {
    // best-effort: 記録できなくても worktree は使える
    return false
  }
}

/**
 * worktree のマニフェストを読み出す。存在しない / 読めない / 壊れている場合は空オブジェクト。
 */
export function loadWtbManagedManifest(cwd: string): WtbManagedManifest {
  const manifestPath = resolveManifestPath(cwd)
  if (!manifestPath || !existsSync(manifestPath)) return {}
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as WtbManagedManifest
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * 追跡ファイルの skip-worktree を解除する (`git update-index --no-skip-worktree`)。
 * remove 側で managed ファイルの真の状態を `git status` に surface させるために使う。
 * best-effort (失敗は無視)。
 */
export function clearSkipWorktree(cwd: string, relativePath: string): void {
  try {
    execGitSafe(["update-index", "--no-skip-worktree", "--", relativePath], { cwd })
  } catch {
    // best-effort
  }
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
  const canonical = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return path.resolve(p)
    }
  }
  return canonical(a) === canonical(b)
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

/**
 * 指定されたディレクトリがworktreeかどうかを判定
 *
 * @param dirPath - チェックするディレクトリパス
 * @param cwd - 対象ディレクトリ（デフォルト: 現在のディレクトリ）
 * @returns worktreeの場合true
 */
export function isWorktree(dirPath: string, cwd?: string): boolean {
  try {
    const worktrees = listWorktrees(cwd)
    const absolutePath = path.resolve(dirPath)
    return worktrees.some((wt) => path.resolve(wt.path) === absolutePath)
  } catch {
    return false
  }
}

/**
 * メインリポジトリとworktreeの関係情報を取得
 *
 * @param cwd - 対象ディレクトリ（デフォルト: 現在のディレクトリ）
 * @returns 関係情報オブジェクト
 */
export function getWorktreeRelationship(cwd?: string) {
  if (!isGitRepository(cwd)) {
    throw new Error("Not in a Git repository")
  }

  const root = getGitRoot(cwd)
  const worktrees = listWorktrees(cwd)
  const currentPath = path.resolve(cwd || process.cwd())

  const mainRepo = worktrees.find((wt) => wt.path === root) || worktrees[0]
  const isCurrentWorktree = worktrees.some(
    (wt) => path.resolve(wt.path) === currentPath && wt.path !== root
  )

  return {
    mainPath: mainRepo?.path || root,
    currentPath,
    isCurrentWorktree,
    totalWorktrees: worktrees.length,
    worktrees,
  }
}
