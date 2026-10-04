/**
 * @fileoverview 安全なコマンド実行ユーティリティ
 * shell injectionを防ぐため execFileSync の引数配列形式を使用
 */

import { execFileSync, execSync } from "node:child_process"
import { AsyncLocalStorage } from "node:async_hooks"
import { FILE_ENCODING } from "../constants/index.js"
import { isJsonOutputMode } from "./output.js"

interface SafeExecOptions {
  cwd?: string
  env?: Record<string, string>
  /** Preserve semantically significant leading whitespace while still trimming trailing output. */
  preserveLeadingWhitespace?: boolean
  timeoutMs?: number
}

const executionDeadline = new AsyncLocalStorage<number>()

/** Bound nested Git, Docker and lifecycle calls with one operation-wide deadline. */
export function withExecDeadline<T>(timeoutMs: number, operation: () => T): T {
  const parent = executionDeadline.getStore() ?? Number.POSITIVE_INFINITY
  return executionDeadline.run(Math.min(parent, Date.now() + timeoutMs), operation)
}

function remainingTimeout(timeoutMs?: number): number | undefined {
  const deadline = executionDeadline.getStore()
  const remaining = Math.min(
    timeoutMs ?? Number.POSITIVE_INFINITY,
    deadline === undefined ? Number.POSITIVE_INFINITY : deadline - Date.now()
  )
  if (remaining <= 0) throw new Error("Operation deadline exceeded")
  return Number.isFinite(remaining) ? Math.max(1, Math.ceil(remaining)) : undefined
}

/**
 * 安全なコマンド実行（shell injection防止）
 * execFileSync を使用して引数を配列で渡す
 */
export function execSafeSync(file: string, args: string[], options?: SafeExecOptions): string {
  try {
    const stdout = execFileSync(file, args, {
      encoding: FILE_ENCODING,
      stdio: "pipe",
      ...(options?.cwd && { cwd: options.cwd }),
      ...(options?.env && { env: { ...process.env, ...options.env } }),
      timeout: remainingTimeout(options?.timeoutMs),
      killSignal: "SIGKILL",
    })
    return options?.preserveLeadingWhitespace ? stdout.trimEnd() : stdout.trim()
  } catch (error) {
    const base = `Command failed: ${file} ${args.join(" ")}`
    // execFileSync の throw には .stderr (コマンドの実エラー出力) が載る。これを優先して
    // 単一の "Command failed: <cmd>\n<stderr>" にする。execFileSync の .message は既に
    // "Command failed: <cmd>" を含むため、そのまま連結すると prefix が重複していた。
    const e = error as { stderr?: Buffer | string }
    const stderr = e.stderr ? e.stderr.toString().trim() : ""
    let detail = stderr
    if (!detail) {
      // stderr が無い失敗 (例: docker/git 未インストールの spawn ENOENT) は message を
      // 使う。ただし既に "Command failed:" で始まる場合は重複させない。
      const msg = error instanceof Error ? error.message : String(error)
      detail = msg.startsWith("Command failed:") ? "" : msg
    }
    throw new Error(detail ? `${base}\n${detail}` : base)
  }
}

/**
 * Git コマンドを安全に実行
 */
export function execGitSafe(args: string[], options?: SafeExecOptions): string {
  return execSafeSync("git", args, options)
}

/**
 * Docker コマンドを安全に実行
 */
export function execDockerSafe(args: string[], options?: SafeExecOptions): string {
  return execSafeSync("docker", args, options)
}

/**
 * ライフサイクルコマンド（start_command / end_command）を実行
 * ユーザー指定のシェルスクリプトなので shell: "/bin/sh" を使用
 *
 * JSON 出力モード中は子プロセスの stdout を stderr (fd 2) に流し、
 * stdout を JSON 専用に保つ。
 */
export function executeLifecycleCommand(command: string, cwd: string): void {
  execSync(command, {
    cwd,
    stdio: isJsonOutputMode() ? [0, 2, 2] : "inherit",
    shell: "/bin/sh",
    timeout: remainingTimeout(),
    killSignal: "SIGKILL",
  })
}
