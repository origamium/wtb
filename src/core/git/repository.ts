/**
 * @fileoverview Git リポジトリ操作
 * Gitリポジトリの基本的な状態確認と情報取得を担当
 */

import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { link, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises"
import * as path from "node:path"
import { EXIT_CODES } from "../../constants/index.js"
import type { ExecOptions } from "../../types/index.js"
import { CLIError } from "../../utils/error.js"
import { execGitSafe } from "../../utils/exec.js"

/**
 * 現在のディレクトリがGitリポジトリかどうかを判定
 *
 * @param cwd - チェックするディレクトリ（デフォルト: 現在のディレクトリ）
 * @returns Gitリポジトリの場合true
 */
export function isGitRepository(cwd?: string): boolean {
  try {
    return execGitSafe(["rev-parse", "--is-inside-work-tree"], { cwd }) === "true"
  } catch {
    return false
  }
}

/** A single, canonical view of the repository a command is running in. */
export interface RepositoryContext {
  /** Root of the worktree containing cwd. */
  currentRoot: string
  /** Root of the primary (first) worktree. */
  mainRoot: string
  /** Git directory shared by every linked worktree. */
  commonGitDir: string
}

function canonicalPath(value: string): string {
  const absolute = path.resolve(value)
  try {
    return realpathSync.native(absolute)
  } catch {
    // Git paths normally exist. Keeping a deterministic absolute fallback makes
    // failures actionable if a worktree disappears between the Git queries.
    return absolute
  }
}

function firstWorktreeRecord(porcelain: string): { path: string; bare: boolean } | null {
  // With -z every field is NUL-delimited and paths are never C-style quoted.
  // Accept newline-delimited output as a defensive fallback for older Git builds.
  const fields = porcelain.includes("\0") ? porcelain.split("\0") : porcelain.split(/\r?\n/)
  const start = fields.findIndex((entry) => entry.startsWith("worktree "))
  if (start < 0) return null
  const worktreePath = fields[start].slice("worktree ".length)
  let bare = false
  for (let index = start + 1; index < fields.length; index++) {
    const field = fields[index]
    if (field === "" || field.startsWith("worktree ")) break
    if (field === "bare") bare = true
  }
  return { path: worktreePath, bare }
}

/**
 * Resolve the current worktree, primary worktree and common Git directory.
 *
 * All returned paths are canonical absolute paths. Bare repositories are
 * intentionally rejected: wtb's copy/link/Compose operations require a
 * checked-out worktree and must never treat a bare repository as one.
 */
export function getRepositoryContext(cwd?: string): RepositoryContext {
  const startDirectory = cwd ?? process.cwd()
  if (!isGitRepository(startDirectory)) {
    throw new CLIError("Not in a git repository", EXIT_CODES.NOT_GIT_REPOSITORY)
  }

  if (execGitSafe(["rev-parse", "--is-bare-repository"], { cwd: startDirectory }) === "true") {
    throw new CLIError("Bare git repositories are not supported", EXIT_CODES.NOT_GIT_REPOSITORY)
  }

  const currentRoot = canonicalPath(
    execGitSafe(["rev-parse", "--show-toplevel"], { cwd: startDirectory })
  )
  const rawCommonGitDir = execGitSafe(["rev-parse", "--git-common-dir"], {
    cwd: startDirectory,
  })
  const commonGitDir = canonicalPath(
    path.isAbsolute(rawCommonGitDir)
      ? rawCommonGitDir
      : path.resolve(startDirectory, rawCommonGitDir)
  )
  const mainWorktree = firstWorktreeRecord(
    execGitSafe(["worktree", "list", "--porcelain", "-z"], { cwd: currentRoot })
  )

  if (!mainWorktree) {
    throw new Error("Unable to resolve the main Git worktree")
  }
  if (mainWorktree.bare) {
    throw new CLIError(
      "Repositories with a bare primary worktree are not supported",
      EXIT_CODES.NOT_GIT_REPOSITORY
    )
  }

  return {
    currentRoot,
    mainRoot: canonicalPath(mainWorktree.path),
    commonGitDir,
  }
}

export const REPOSITORY_LOCK_DIR_NAME = "wtb.lock"
export const REPOSITORY_LOCK_OWNER_FILE = "owner.json"
export const REPOSITORY_LOCK_WAIT_MS = 5 * 60 * 1000
export const REPOSITORY_LOCK_POLL_MS = 100
export const REPOSITORY_LOCK_STALE_MS = 10 * 60 * 1000

interface RepositoryLockOwner {
  pid: number
  startedAt: number
  token: string
}

export interface RepositoryLockOptions {
  /** Maximum time to wait for another wtb process. Defaults to five minutes. */
  waitTimeoutMs?: number
  /** Delay between lock attempts. Defaults to roughly 100ms. */
  pollIntervalMs?: number
}

export type ReleaseRepositoryLock = () => Promise<void>

function isErrnoException(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  )
}

function isValidLockOwner(value: unknown): value is RepositoryLockOwner {
  if (typeof value !== "object" || value === null) return false
  const owner = value as Partial<RepositoryLockOwner>
  return (
    Number.isSafeInteger(owner.pid) &&
    (owner.pid ?? 0) > 0 &&
    typeof owner.startedAt === "number" &&
    Number.isFinite(owner.startedAt) &&
    typeof owner.token === "string" &&
    owner.token.length > 0
  )
}

async function readLockOwner(lockDirectory: string): Promise<RepositoryLockOwner | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(lockDirectory, REPOSITORY_LOCK_OWNER_FILE), "utf8")
    )
    return isValidLockOwner(parsed) ? parsed : null
  } catch {
    // A missing or corrupt owner must fail closed. Without a PID we cannot meet
    // the dead-process requirement for stale-lock reclamation.
    return null
  }
}

async function readOwnerFile(ownerPath: string): Promise<RepositoryLockOwner | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(ownerPath, "utf8"))
    return isValidLockOwner(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but is owned by another user. Only ESRCH
    // proves that the PID is no longer alive.
    return !isErrnoException(error, "ESRCH")
  }
}

async function writeLockOwner(lockDirectory: string, owner: RepositoryLockOwner): Promise<void> {
  const ownerPath = path.join(lockDirectory, REPOSITORY_LOCK_OWNER_FILE)
  const handle = await open(ownerPath, "wx", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function tryReclaimStaleLock(lockDirectory: string, now: number): Promise<boolean> {
  const owner = await readLockOwner(lockDirectory)
  if (!owner || now - owner.startedAt <= REPOSITORY_LOCK_STALE_MS || isProcessAlive(owner.pid)) {
    return false
  }

  // A fixed exclusive claim prevents two waiters from both renaming a stale
  // directory, where the slower waiter could otherwise move a newly acquired lock.
  const reclaimPath = path.join(lockDirectory, "reclaim")
  const claimOwner: RepositoryLockOwner = {
    pid: process.pid,
    startedAt: now,
    token: randomUUID(),
  }
  const stagedClaimPath = path.join(
    lockDirectory,
    `.reclaim-${process.pid}-${claimOwner.token}.tmp`
  )
  try {
    const staged = await open(stagedClaimPath, "wx", 0o600)
    try {
      await staged.writeFile(`${JSON.stringify(claimOwner)}\n`, "utf8")
      await staged.sync()
    } finally {
      await staged.close()
    }
    await link(stagedClaimPath, reclaimPath)
  } catch (error) {
    await unlink(stagedClaimPath).catch(() => undefined)
    if (isErrnoException(error, "EEXIST")) {
      const existingClaim = await readOwnerFile(reclaimPath)
      if (
        existingClaim &&
        now - existingClaim.startedAt > REPOSITORY_LOCK_STALE_MS &&
        !isProcessAlive(existingClaim.pid)
      ) {
        await unlink(reclaimPath).catch(() => undefined)
      }
      return false
    }
    if (isErrnoException(error, "ENOENT")) return false
    throw error
  } finally {
    await unlink(stagedClaimPath).catch(() => undefined)
  }

  let moved = false
  try {
    // Re-read after claiming so a changed owner can never be reclaimed based on
    // the stale snapshot above.
    const confirmed = await readLockOwner(lockDirectory)
    if (
      !confirmed ||
      confirmed.token !== owner.token ||
      now - confirmed.startedAt <= REPOSITORY_LOCK_STALE_MS ||
      isProcessAlive(confirmed.pid)
    ) {
      return false
    }

    const quarantine = `${lockDirectory}.stale-${process.pid}-${randomUUID()}`
    await rename(lockDirectory, quarantine)
    moved = true
    await rm(quarantine, { recursive: true, force: true })
    return true
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) return false
    throw error
  } finally {
    if (!moved) {
      await unlink(reclaimPath).catch((error: unknown) => {
        if (!isErrnoException(error, "ENOENT")) throw error
      })
    }
  }
}

function lockDirectoryFrom(context: RepositoryContext | string): string {
  const commonGitDir = typeof context === "string" ? context : context.commonGitDir
  return path.join(canonicalPath(commonGitDir), REPOSITORY_LOCK_DIR_NAME)
}

/**
 * Acquire the repository-wide wtb lock using an atomic mkdir.
 *
 * The returned release function is idempotent and validates its owner token,
 * so an old process can never remove a lock acquired by a newer process.
 */
export async function acquireRepositoryLock(
  context: RepositoryContext | string,
  options: RepositoryLockOptions = {}
): Promise<ReleaseRepositoryLock> {
  const waitTimeoutMs = options.waitTimeoutMs ?? REPOSITORY_LOCK_WAIT_MS
  const pollIntervalMs = options.pollIntervalMs ?? REPOSITORY_LOCK_POLL_MS
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 0) {
    throw new RangeError("waitTimeoutMs must be a finite non-negative number")
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError("pollIntervalMs must be a finite positive number")
  }

  const lockDirectory = lockDirectoryFrom(context)
  const startedWaitingAt = Date.now()
  const deadline = startedWaitingAt + waitTimeoutMs
  const token = randomUUID()

  while (true) {
    const stagedDirectory = `${lockDirectory}.claim-${process.pid}-${token}`
    try {
      await mkdir(stagedDirectory, { mode: 0o700 })
      const owner: RepositoryLockOwner = {
        pid: process.pid,
        startedAt: Date.now(),
        token,
      }
      try {
        await writeLockOwner(stagedDirectory, owner)
        await rename(stagedDirectory, lockDirectory)
      } catch (error) {
        await rm(stagedDirectory, { recursive: true, force: true }).catch(() => undefined)
        if (isErrnoException(error, "EEXIST") || isErrnoException(error, "ENOTEMPTY")) {
          // Another fully-published lock won the atomic rename.
          throw Object.assign(new Error("Repository lock exists"), { code: "EEXIST" })
        }
        throw error
      }

      let released = false
      return async () => {
        if (released) return
        const currentOwner = await readLockOwner(lockDirectory)
        if (!currentOwner || currentOwner.token !== owner.token) {
          released = true
          return
        }

        // Rename first: this removes the fixed lock path atomically, then cleanup
        // happens only in our token-specific quarantine directory.
        const quarantine = `${lockDirectory}.release-${process.pid}-${owner.token}`
        await rename(lockDirectory, quarantine)
        released = true
        await rm(quarantine, { recursive: true, force: true })
      }
    } catch (error) {
      if (!isErrnoException(error, "EEXIST")) throw error
    }

    const now = Date.now()
    if (await tryReclaimStaleLock(lockDirectory, now)) continue

    if (now >= deadline) {
      const currentOwner = await readLockOwner(lockDirectory)
      const ownerDescription = currentOwner
        ? ` (held by PID ${currentOwner.pid} since ${new Date(currentOwner.startedAt).toISOString()})`
        : ""
      throw new Error(
        `Timed out after ${waitTimeoutMs}ms waiting for repository lock: ${lockDirectory}${ownerDescription}`
      )
    }

    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - now)))
    )
  }
}

/** Run an operation while holding the repository-wide wtb lock. */
export async function withRepositoryLock<T>(
  context: RepositoryContext | string,
  operation: () => T | Promise<T>,
  options?: RepositoryLockOptions
): Promise<T> {
  const release = await acquireRepositoryLock(context, options)
  try {
    return await operation()
  } finally {
    await release()
  }
}

/**
 * Gitリポジトリのルートディレクトリを取得
 *
 * @param cwd - 開始ディレクトリ（デフォルト: 現在のディレクトリ）
 * @returns リポジトリのルートディレクトリパス
 * @throws {Error} Gitリポジトリではない場合
 */
export function getGitRoot(cwd?: string): string {
  if (!isGitRepository(cwd)) {
    throw new Error("Not in a Git repository")
  }
  return execGitSafe(["rev-parse", "--show-toplevel"], { cwd })
}

/**
 * Git リポジトリ内であることを保証してルートを返す（CLI コマンド向けガード）
 *
 * リポジトリでない場合は CLIError(NOT_GIT_REPOSITORY) を throw するので、
 * 呼び出し側は withErrorHandling 経由で適切な exit code に変換される。
 */
export function getGitRootOrThrow(cwd?: string): string {
  if (!isGitRepository(cwd)) {
    throw new CLIError("Not in a git repository", EXIT_CODES.NOT_GIT_REPOSITORY)
  }
  return getGitRoot(cwd)
}

/**
 * main worktree (source リポジトリ) のルートを取得
 *
 * `rev-parse --show-toplevel` は linked worktree の中では **その worktree 自身の**
 * ルートを返す。source リポジトリを意図する処理 (up/down/reclone の same-project
 * ガードや source compose の解決) がそれを使うと、worktree 内から実行したときに
 * gitRoot == worktreePath となり誤動作する。source を指すべき箇所はこちらを使う。
 *
 * repository context は `git worktree list --porcelain -z` の先頭エントリを使うため、
 * common Git directory が main worktree 外に置かれた構成でも source を識別できる。
 */
export function getMainWorktreeRoot(cwd?: string): string {
  return getRepositoryContext(cwd).mainRoot
}

/**
 * 現在のブランチ名を取得
 *
 * @param cwd - 対象ディレクトリ（デフォルト: 現在のディレクトリ）
 * @returns 現在のブランチ名
 * @throws {Error} Gitリポジトリではない場合
 */
export function getCurrentBranch(cwd?: string): string {
  if (!isGitRepository(cwd)) {
    throw new Error("Not in a Git repository")
  }
  return execGitSafe(["branch", "--show-current"], { cwd })
}

/**
 * 指定したブランチが存在するかチェック
 *
 * @param branchName - チェックするブランチ名
 * @param cwd - 対象ディレクトリ（デフォルト: 現在のディレクトリ）
 * @returns ブランチが存在する場合true
 */
export function branchExists(branchName: string, cwd?: string): boolean {
  if (!isGitRepository(cwd)) {
    return false
  }

  try {
    execGitSafe(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { cwd })
    return true
  } catch {
    return false
  }
}

/**
 * 任意の revision (ブランチ / タグ / SHA / remote ref 等) が commit に解決できるかチェック
 *
 * branchExists は refs/heads/ しか見ないため、base_branch に有効なタグ・SHA・
 * remote ref を指定したケースを誤って弾いてしまう。base_branch の事前検証には
 * こちらを使う。
 *
 * @param revision - チェックする revision
 * @param cwd - 対象ディレクトリ（デフォルト: 現在のディレクトリ）
 * @returns commit に解決できる場合true
 */
export function revisionExists(revision: string, cwd?: string): boolean {
  if (!isGitRepository(cwd)) {
    return false
  }

  try {
    // --end-of-options: `-` 始まりの base_branch (config 由来) がフラグとして解釈されて
    // 誤ったエラーになるのを防ぐ。
    execGitSafe(["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`], {
      cwd,
    })
    return true
  } catch {
    return false
  }
}

/**
 * 指定したブランチがリモート (origin) に存在するかチェック
 *
 * ローカルに無いブランチでも、teammate が push 済みの remote-only ブランチを
 * base_branch から作り直して黙って shadow しないために使う。
 *
 * @param branchName - チェックするブランチ名
 * @param remote - リモート名（デフォルト: origin）
 * @param cwd - 対象ディレクトリ（デフォルト: 現在のディレクトリ）
 * @returns リモートブランチが存在する場合true
 */
export function remoteBranchExists(branchName: string, remote = "origin", cwd?: string): boolean {
  if (!isGitRepository(cwd)) {
    return false
  }

  try {
    execGitSafe(["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branchName}`], {
      cwd,
    })
    return true
  } catch {
    return false
  }
}

/**
 * リポジトリの基本情報を取得
 *
 * @param cwd - 対象ディレクトリ（デフォルト: 現在のディレクトリ）
 * @returns リポジトリ情報オブジェクト
 * @throws {Error} Gitリポジトリではない場合
 */
export function getRepositoryInfo(cwd?: string) {
  if (!isGitRepository(cwd)) {
    throw new Error("Not in a Git repository")
  }

  const root = getGitRoot(cwd)
  const currentBranch = getCurrentBranch(cwd)

  // リポジトリの状態をチェック
  let isClean: boolean
  try {
    const status = execGitSafe(["status", "--porcelain"], { cwd })
    isClean = status.length === 0
  } catch {
    isClean = false
  }

  return {
    root,
    currentBranch,
    isClean,
    isGitRepository: true,
  }
}

// ExecOptions is kept for backward compatibility with any callers
export type { ExecOptions }
