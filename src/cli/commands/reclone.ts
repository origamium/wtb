/**
 * @fileoverview Reclone コマンド実装
 *
 * 既存 worktree の volume-clone フェーズだけを再実行する recovery コマンド。
 * create 時に clone が失敗/skip された (空/古い volume) 場合に、worktree を作り
 * 直さずにデータだけ復旧できる。coding agent が破壊的な remove→create を経ずに
 * データ自律性を回復するための primitive。
 */

import { Command } from "commander"
import { EXIT_CODES } from "../../constants/index.js"
import { loadConfig } from "../../core/config/loader.js"
import { getRepositoryContext } from "../../core/git/repository.js"
import { isSamePath } from "../../core/git/worktree.js"
import { CLIError } from "../../utils/error.js"
import { out, setJsonOutputMode } from "../../utils/output.js"
import { resolveWorktreeTarget, withErrorHandling } from "../utils/command-helpers.js"
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

  // NOTE: getGitRootOrThrow (--show-toplevel) は worktree 内では worktree 自身を返すため
  // 使えない — source を指す main worktree root が必要 (でないと worktree 内からの実行が
  // 常に main-repo ガードで拒否される)。
  const repository = getRepositoryContext()
  const gitRoot = repository.mainRoot

  // 対象 worktree の解決: branch 指定があればそれ、無ければ cwd を含む worktree。
  const { worktreePath, targetBranch } = resolveWorktreeTarget("reclone", branch)

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
  // create の payload と揃えるため top-level に sourceRestartFailed を出す。これにより
  // 消費側は「volume の clone 失敗」と「source スタックが DOWN (再開失敗)」を区別できる。
  const writeJsonResult = (
    volumes: VolumeCopyResult,
    ok: boolean,
    sourceRestartFailed = false
  ): void => {
    process.stdout.write(
      `${JSON.stringify(
        {
          branch: targetBranch,
          path: worktreePath,
          dryRun: options.dryRun === true,
          volumes,
          sourceRestartFailed,
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
    branch: targetBranch,
    commonGitDir: repository.commonGitDir,
  })

  // source スタックを停止したまま再開に失敗した = ユーザの稼働中環境が壊れた状態。
  // --strict の有無に関わらず非ゼロ終了 (DOCKER_ERROR) する (create.ts と同じ contract)。
  // `compose stop` 自体が失敗しても一部 service だけ停止済みの可能性がある。
  // その復旧にも失敗した場合は、stop の完了可否に関係なく hard Docker failure。
  const sourceRestartFailed = result.sourceStack?.restarted === false

  out("")
  if (result.failed.length > 0) {
    // 既定では create と同じ contract: コマンドは exit 0 だが、データ未達成を明示する。
    out(
      `⚠️  Reclone finished, but ${result.failed.length} volume(s) FAILED — this worktree's data is NOT fully isolated. See the errors above; resolve them and re-run \`wtb reclone\`.`
    )
    if (json) {
      writeJsonResult(result, false, sourceRestartFailed)
    }
  } else {
    out(
      `✅ Reclone complete — ${result.cloned.length} cloned, ${result.skipped.length} skipped, 0 failed.`
    )
    if (json) {
      writeJsonResult(result, !sourceRestartFailed, sourceRestartFailed)
    }
  }

  // 再開失敗時は recovery コマンドを stderr に出す (human モード)。
  if (sourceRestartFailed && result.sourceStack?.recoverCommand) {
    out(
      "  ❌ The source Compose stack was stopped to clone volumes but FAILED to restart — your source environment is DOWN. Bring it back up manually:"
    )
    out(`     ${result.sourceStack.recoverCommand}`)
  }

  // exit code 解決 (即 process.exit せず process.exitCode を設定して JSON flush を保証):
  // - source 再開失敗は --strict 無関係に DOCKER_ERROR (5)
  // - --strict 時の clone 失敗は GENERAL_ERROR (1)
  if (sourceRestartFailed) {
    process.exitCode = EXIT_CODES.DOCKER_ERROR
  } else if (result.failed.length > 0 && options.strict === true) {
    if (json) {
      process.exitCode = EXIT_CODES.GENERAL_ERROR
    } else {
      process.exit(EXIT_CODES.GENERAL_ERROR)
    }
  }
}
