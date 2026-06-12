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
import { out, setJsonOutputMode } from "../../utils/output.js"
import { withErrorHandling } from "../utils/command-helpers.js"
import {
  emptyVolumeCopyResult,
  previewVolumeCopy,
  setupVolumeCopy,
  type VolumeCopyResult,
} from "./create.js"

interface RecloneOptions {
  forceVolumeCopy?: boolean
  stop?: boolean
  strict?: boolean
  dryRun?: boolean
  json?: boolean
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
    .option(
      "--json",
      "Output one machine-readable JSON result on stdout (human progress goes to stderr)"
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
  // モジュール状態なので毎回明示的に設定する (前回実行のモードを引き継がない)。
  const json = options.json === true
  setJsonOutputMode(json)

  const gitRoot = getGitRootOrThrow()

  // 対象 worktree の解決: branch 指定があればそれ、無ければ cwd を含む worktree。
  let worktreePath: string
  let targetBranch: string
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

  // --json: stdout には JSON オブジェクトを 1 つだけ出力する (人間向け出力は stderr 済み)。
  const writeJsonResult = (volumes: VolumeCopyResult, ok: boolean): void => {
    process.stdout.write(
      `${JSON.stringify(
        {
          branch: targetBranch,
          path: worktreePath,
          dryRun: options.dryRun === true,
          volumes,
          ok,
        },
        null,
        2
      )}\n`
    )
  }

  if (!config.docker_compose_file) {
    out("ℹ️  No docker_compose_file configured — there are no volumes to clone.")
    if (json) {
      writeJsonResult(emptyVolumeCopyResult(), true)
    }
    return
  }

  out(`🔁 Re-cloning volumes for branch: ${targetBranch}`)
  out(`📂 Worktree path: ${worktreePath}`)
  out("")

  if (options.dryRun) {
    out("🔍 Dry run mode — no changes will be made")
    previewVolumeCopy(gitRoot, config)
    if (json) {
      writeJsonResult(emptyVolumeCopyResult(), true)
    }
    return
  }

  const result = await setupVolumeCopy(gitRoot, worktreePath, config, {
    force: options.forceVolumeCopy === true,
    stop: options.stop,
  })

  out("")
  if (result.failed.length > 0) {
    // 既定では create と同じ contract: コマンドは exit 0 だが、データ未達成を明示する。
    out(
      `⚠️  Reclone finished, but ${result.failed.length} volume(s) FAILED — this worktree's data is NOT fully isolated. See the errors above; resolve them and re-run \`wtb reclone\`.`
    )
    if (json) {
      writeJsonResult(result, false)
    }
    // --strict のときだけ非ゼロ終了して CI/エージェントに失敗を伝える。
    // JSON モードでは payload を書き切ってから exitCode のみ設定する (即 process.exit
    // すると stdout の flush 前に落ちて JSON が壊れる恐れがある)。
    if (options.strict === true) {
      if (json) {
        process.exitCode = EXIT_CODES.GENERAL_ERROR
      } else {
        process.exit(EXIT_CODES.GENERAL_ERROR)
      }
    }
  } else {
    out(
      `✅ Reclone complete — ${result.cloned.length} cloned, ${result.skipped.length} skipped, 0 failed.`
    )
    if (json) {
      writeJsonResult(result, true)
    }
  }
}
