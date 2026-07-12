/**
 * @fileoverview コマンド共通ヘルパー
 */

import * as path from "node:path"
import { EXIT_CODES } from "../../constants/index.js"
import { canonicalPath, getWorktreePath, listWorktrees } from "../../core/git/worktree.js"
import { CLIError, getErrorMessage } from "../../utils/error.js"

/**
 * コマンド action の標準エラーハンドリングラッパー
 *
 * Commander の `.action(...)` に渡すハンドラを包み、CLIError は exitCode を尊重して、
 * その他のエラーは GENERAL_ERROR で終了させる。
 */
export function withErrorHandling<A extends unknown[]>(
  handler: (...args: A) => Promise<void>
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await handler(...args)
    } catch (error) {
      if (error instanceof CLIError) {
        console.error(`Error: ${error.message}`)
        process.exit(error.exitCode)
      }
      console.error(`Error: ${getErrorMessage(error)}`)
      process.exit(EXIT_CODES.GENERAL_ERROR)
    }
  }
}

/**
 * 対象 worktree の解決: branch 指定があればそれ、無ければ cwd を含む worktree。
 *
 * up / down / reclone が共有する。cwd 判定は canonical パスのプレフィックス比較で行い、
 * 入れ子の worktree (main repo 配下に worktree を作った場合) でも最も深いマッチを選ぶ
 * (先頭マッチだと main worktree が常に勝ってしまい誤って main と判定される)。
 *
 * @param command - エラーメッセージ用のコマンド名 (例: "up", "reclone")
 * @param branch - 明示指定されたブランチ (省略時は cwd から解決)
 */
export function resolveWorktreeTarget(
  command: string,
  branch: string | undefined
): { worktreePath: string; targetBranch: string } {
  if (branch) {
    const resolved = getWorktreePath(branch)
    if (!resolved) {
      // 一覧はエラー診断の一部なので stderr に出す (stdout を script 出力用に汚さない)。
      // "Error: ..." 本文は withErrorHandling が CLIError から stderr へ出力する。
      console.error("Available worktrees:")
      for (const wt of listWorktrees()) {
        console.error(`  ${wt.branch}: ${wt.path}`)
      }
      throw new CLIError(`No worktree found for branch '${branch}'`, EXIT_CODES.GENERAL_ERROR)
    }
    return { worktreePath: resolved, targetBranch: branch }
  }

  const cwd = canonicalPath(process.cwd())
  const match = listWorktrees()
    .map((wt) => ({ wt, canon: canonicalPath(wt.path) }))
    .filter(({ canon }) => cwd === canon || cwd.startsWith(`${canon}${path.sep}`))
    .sort((a, b) => b.canon.length - a.canon.length)[0]
  if (!match) {
    throw new CLIError(
      `Could not determine the current worktree — run \`wtb ${command} <branch>\` with an explicit branch, or cd into a worktree.`,
      EXIT_CODES.GENERAL_ERROR
    )
  }
  return { worktreePath: match.wt.path, targetBranch: match.wt.branch }
}
