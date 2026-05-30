/**
 * @fileoverview Reclone コマンド実装
 *
 * 既存 worktree の volume-clone フェーズだけを再実行する recovery コマンド。
 * create 時に clone が失敗/skip された (空/古い volume) 場合に、worktree を作り
 * 直さずにデータだけ復旧できる。coding agent が破壊的な remove→create を経ずに
 * データ自律性を回復するための primitive。
 */

import * as path from "node:path"
import { Command } from "commander"
import { EXIT_CODES } from "../../constants/index.js"
import { loadConfig } from "../../core/config/loader.js"
import { getGitRootOrThrow } from "../../core/git/repository.js"
import { getWorktreePath, isSamePath, listWorktrees } from "../../core/git/worktree.js"
import { CLIError } from "../../utils/error.js"
import { withErrorHandling } from "../utils/command-helpers.js"
import { previewVolumeCopy, setupVolumeCopy } from "./create.js"

interface RecloneOptions {
  forceVolumeCopy?: boolean
  stop?: boolean
  strict?: boolean
  dryRun?: boolean
}

/**
 * recloneコマンドを作成
 */
export function recloneCommand(): Command {
  return new Command("reclone")
    .description(
      "Re-run the volume-clone phase for an existing worktree (recover empty/failed/stale volumes without recreating it)"
    )
    .argument(
      "[branch]",
      "Branch whose worktree to re-clone volumes for (default: the current worktree)"
    )
    .option(
      "--force-volume-copy",
      "Clone even when the source container is running or the target volume already has data"
    )
    .option(
      "--no-stop",
      "Don't auto-stop the source Compose stack before cloning live volumes (skip in-use volumes instead)"
    )
    .option(
      "--strict",
      "Exit non-zero (1) if any volume fails to clone (default: exit 0). Use in CI / coding-agent pipelines that must detect incomplete data isolation."
    )
    .option("--dry-run", "Show what would be cloned without making changes")
    .action(withErrorHandling(executeRecloneCommand))
}

/**
 * recloneコマンドのメイン実行ロジック
 */
async function executeRecloneCommand(
  branch: string | undefined,
  options: RecloneOptions
): Promise<void> {
  const gitRoot = getGitRootOrThrow()

  // 対象 worktree の解決: branch 指定があればそれ、無ければ cwd を含む worktree。
  let worktreePath: string
  let targetBranch: string
  if (branch) {
    const resolved = getWorktreePath(branch)
    if (!resolved) {
      console.error(`Error: No worktree found for branch '${branch}'`)
      console.log("")
      console.log("Available worktrees:")
      for (const wt of listWorktrees()) {
        console.log(`  ${wt.branch}: ${wt.path}`)
      }
      throw new CLIError(`No worktree found for branch '${branch}'`, EXIT_CODES.GENERAL_ERROR)
    }
    worktreePath = resolved
    targetBranch = branch
  } else {
    const cwd = path.resolve(process.cwd())
    const match = listWorktrees().find((wt) => {
      const r = path.resolve(wt.path)
      return cwd === r || cwd.startsWith(`${r}${path.sep}`)
    })
    if (!match) {
      throw new CLIError(
        "Could not determine the current worktree — run `wtb reclone <branch>` with an explicit branch, or cd into a worktree.",
        EXIT_CODES.GENERAL_ERROR
      )
    }
    worktreePath = match.path
    targetBranch = match.branch
  }

  // main repo を対象にすると source project == target project になり、volume を
  // 自分自身にクローンする無意味/危険な操作になるため拒否する。
  // symlink 経由でガードを回避されないよう canonical path で比較する。
  if (isSamePath(worktreePath, gitRoot)) {
    throw new CLIError(
      "Refusing to reclone into the main repository worktree (source and target would be the same project). Run reclone for a non-main worktree.",
      EXIT_CODES.GENERAL_ERROR
    )
  }

  const config = loadConfig(gitRoot)

  if (!config.docker_compose_file) {
    console.log("ℹ️  No docker_compose_file configured — there are no volumes to clone.")
    return
  }

  console.log(`🔁 Re-cloning volumes for branch: ${targetBranch}`)
  console.log(`📂 Worktree path: ${worktreePath}`)
  console.log("")

  if (options.dryRun) {
    console.log("🔍 Dry run mode — no changes will be made")
    previewVolumeCopy(gitRoot, config)
    return
  }

  const result = await setupVolumeCopy(gitRoot, worktreePath, config, {
    force: options.forceVolumeCopy === true,
    stop: options.stop,
  })

  console.log("")
  if (result.failed > 0) {
    // 既定では create と同じ contract: コマンドは exit 0 だが、データ未達成を明示する。
    console.log(
      `⚠️  Reclone finished, but ${result.failed} volume(s) FAILED — this worktree's data is NOT fully isolated. See the errors above; resolve them and re-run \`wtb reclone\`.`
    )
    // --strict のときだけ非ゼロ終了して CI/エージェントに失敗を伝える。
    if (options.strict === true) {
      process.exit(EXIT_CODES.GENERAL_ERROR)
    }
  } else {
    console.log(
      `✅ Reclone complete — ${result.copied} cloned, ${result.skipped} skipped, 0 failed.`
    )
  }
}
