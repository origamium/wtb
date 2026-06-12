/**
 * @fileoverview `wtb path` コマンド実装
 *
 * ブランチ名から worktree の絶対パスを 1 行で返す。
 * `cd "$(wtb path feature/x)"` のように script / coding agent が決定的に
 * worktree へ移動するための primitive (fzf 等の対話なしで使える)。
 */

import * as path from "node:path"
import { Command } from "commander"
import { EXIT_CODES } from "../../constants/index.js"
import { getGitRootOrThrow } from "../../core/git/repository.js"
import { getWorktreePath, listWorktrees } from "../../core/git/worktree.js"
import { CLIError } from "../../utils/error.js"
import { withErrorHandling } from "../utils/command-helpers.js"

/**
 * pathコマンドを作成
 */
export function pathCommand(): Command {
  return new Command("path")
    .description('Print the worktree path for a branch (for cd "$(wtb path <branch>)")')
    .argument("<branch>", "Branch whose worktree path to print")
    .action(withErrorHandling(executePathCommand))
}

async function executePathCommand(branch: string): Promise<void> {
  getGitRootOrThrow()

  const worktreePath = getWorktreePath(branch)
  if (!worktreePath) {
    // 一覧はエラー診断の一部なので stderr に出す (stdout を script 出力用に汚さない)。
    // "Error: ..." 本文は withErrorHandling が CLIError から stderr へ出力する。
    console.error("Available worktrees:")
    for (const wt of listWorktrees()) {
      console.error(`  ${wt.branch}: ${wt.path}`)
    }
    throw new CLIError(`Worktree not found for branch: ${branch}`, EXIT_CODES.GENERAL_ERROR)
  }

  process.stdout.write(`${path.resolve(worktreePath)}\n`)
}
