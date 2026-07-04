/**
 * @fileoverview Create コマンド実装
 * Git worktreeの作成を担当
 */

import { existsSync, lstatSync, readlinkSync, statSync, symlinkSync } from "node:fs"
import * as path from "node:path"
import { Command } from "commander"
import fs from "fs-extra"
import { EXIT_CODES } from "../../constants/index.js"
import { loadConfig } from "../../core/config/loader.js"
import { getUsedPorts } from "../../core/docker/client.js"
import {
  adjustPortsInCompose,
  type ComposeIdentityRewrite,
  type ComposeValueChange,
  composeStart,
  composeStop,
  composeUp,
  parsePortMapping,
  propagatePortsInComposeValues,
  readComposeFile,
  resolveComposeProjectName,
  rewriteComposeIdentity,
  uniqueProjectSlug,
  writeComposeFile,
} from "../../core/docker/compose.js"
import {
  copyVolume,
  discoverCloneableVolumes,
  getContainersUsingVolume,
  getContainersUsingVolumeWithProject,
  getVolumeSize,
  repoVolumeLabel,
  type ResolvedVolume,
  resolveVolumeName,
  volumeExists,
  volumeIsWtbManaged,
} from "../../core/docker/volume.js"
import {
  copyAndAdjustEnvFile,
  type EnvAdjustmentChange,
  parseEnvFile,
  writeEnvFile,
} from "../../core/environment/processor.js"
import { buildPortMap, propagatePortsInValue } from "../../core/environment/propagate.js"
import {
  branchExists,
  getGitRootOrThrow,
  remoteBranchExists,
  revisionExists,
} from "../../core/git/repository.js"
import {
  createWorktree,
  getWorktreePath,
  listWorktrees,
  markWtbManagedFile,
} from "../../core/git/worktree.js"
import type { ComposeConfig, WtbConfig } from "../../types/index.js"
import { CLIError, getErrorMessage } from "../../utils/error.js"
import { executeLifecycleCommand } from "../../utils/exec.js"
import { out, setJsonOutputMode } from "../../utils/output.js"
import { withErrorHandling } from "../utils/command-helpers.js"
import { createVolumeCopyProgressHandler } from "../utils/progress.js"
import { runRelocatabilityPreflight } from "./doctor.js"

interface CreateOptions {
  path?: string
  createBranch?: boolean
  docker?: boolean
  env?: boolean
  copy?: boolean
  link?: boolean
  start?: boolean
  volumeCopy?: boolean
  forceVolumeCopy?: boolean
  stop?: boolean
  seed?: boolean
  strict?: boolean
  dryRun?: boolean
  existsOk?: boolean
  json?: boolean
}

/** `wtb create --json` / `wtb reclone --json` で報告する host ポートの remap。 */
export type ComposePortChanges = Record<string, Array<{ from: number; to: number }>>

/**
 * setupVolumeCopy の per-volume 結果。
 * - cloned: 正常にクローンできた volume の compose key 一覧
 * - skipped: 意図的に skip した volume と理由 (external / source 不在 /
 *   target にデータあり / --no-stop で稼働中 / 停止後も別 project が使用中)
 * - failed: copyVolume が例外を投げた volume とエラー (= データ分離が未達成)。
 *   1 件以上なら worktree は作成されてもデータ的に半端な状態なので、呼び出し側で
 *   明示的に surface する。
 * 件数は各配列の length から導出する (旧 copied/skipped/failed カウント)。
 */
export interface VolumeCopyResult {
  cloned: string[]
  skipped: Array<{ name: string; reason: string }>
  failed: Array<{ name: string; error: string }>
  /**
   * source スタックを停止した場合のみ設定する。restarted=false なら、ユーザの稼働中
   * 環境が壊れたまま (再開失敗) なので、呼び出し側は非ゼロ終了し recoverCommand を出す。
   */
  sourceStack?: {
    stopped: boolean
    restarted: boolean
    restartError?: string
    recoverCommand?: string
  }
}

/** 空の VolumeCopyResult を生成する (共有 mutable 定数を避けるためのファクトリ)。 */
export function emptyVolumeCopyResult(): VolumeCopyResult {
  return { cloned: [], skipped: [], failed: [] }
}

/**
 * createコマンドを作成
 */
export function createCommand(): Command {
  return new Command("create")
    .description("Create a new git worktree for the specified branch")
    .argument("<branch>", "Branch name to create worktree for")
    .option("-p, --path <path>", "Custom path for the worktree")
    .option("--no-create-branch", "Use existing branch instead of creating new one")
    .option(
      "--no-docker",
      "Skip Docker Compose copy/port-remap (also skips volume cloning — the worktree starts with empty volumes)"
    )
    .option("--no-env", "Skip environment file processing")
    .option("--no-copy", "Skip file copying")
    .option("--no-link", "Skip symlink creation")
    .option("--no-start", "Skip start_command execution")
    .option("--no-volume-copy", "Skip cloning Docker volumes from the source project")
    .option(
      "--force-volume-copy",
      "Clone volumes even when the source container is running or the target volume already has data"
    )
    .option(
      "--no-stop",
      "Don't auto-stop the source Compose stack before cloning live volumes (skip in-use volumes instead)"
    )
    .option(
      "--seed",
      "Seed the data instead of cloning volumes: skip the volume-clone phase and run `volumes.seed_command` in the new worktree (never touches the source volume, so the source stack is left running)"
    )
    .option(
      "--strict",
      "Exit non-zero (1) if any volume clone or the seed command fails (default: exit 0 — the worktree still exists). Use in CI / coding-agent pipelines that must detect incomplete data isolation."
    )
    .option(
      "--exists-ok",
      "If a worktree for the branch already exists, print its path and exit 0 instead of failing"
    )
    .option(
      "--json",
      "Output one machine-readable JSON result on stdout (human progress goes to stderr)"
    )
    .option("--dry-run", "Show what would be done without making changes")
    .action(withErrorHandling(executeCreateCommand))
}

/**
 * createコマンドのメイン実行ロジック
 */
async function executeCreateCommand(branch: string, options: CreateOptions): Promise<void> {
  // モジュール状態なので毎回明示的に設定する (前回実行のモードを引き継がない)。
  const json = options.json === true
  setJsonOutputMode(json)

  const gitRoot = getGitRootOrThrow()

  // 既存のworktreeチェック
  const existingPath = getWorktreePath(branch)
  if (existingPath) {
    if (options.existsOk === true) {
      // 冪等な "ensure worktree exists" 経路: 何も触らず exit 0 で返す。
      out(`ℹ️  Worktree for branch '${branch}' already exists at: ${existingPath} (--exists-ok)`)
      if (json) {
        writeJsonResult({
          branch,
          path: existingPath,
          created: false,
          existing: true,
          createdBranch: false,
          dryRun: options.dryRun === true,
          ok: true,
        })
      }
      return
    }
    throw new CLIError(
      `Worktree for branch '${branch}' already exists at: ${existingPath}`,
      EXIT_CODES.WORKTREE_EXISTS
    )
  }

  // ブランチ名のサニタイズ（パス用）
  const sanitizedBranch = branch.replace(/\//g, "-")

  // worktreeパスの決定
  const worktreePath = options.path
    ? path.resolve(options.path)
    : path.join(path.dirname(gitRoot), `worktree-${sanitizedBranch}`)

  const skipDocker = options.docker === false
  const skipEnv = options.env === false
  const skipCopy = options.copy === false
  const skipLink = options.link === false
  const skipStart = options.start === false
  const skipVolumeCopy = options.volumeCopy === false
  const forceVolumeCopy = options.forceVolumeCopy === true
  const useSeed = options.seed === true
  const dryRun = options.dryRun === true

  if (dryRun) {
    out("🔍 Dry run mode — no changes will be made")
    out("")
  }

  out(`🌿 Creating worktree for branch: ${branch}`)
  out(`📂 Worktree path: ${worktreePath}`)

  // ブランチが既に存在するかチェック
  const branchAlreadyExists = branchExists(branch)

  // --no-create-branch が指定されたのに対象ブランチが存在しない場合はエラー
  if (options.createBranch === false && !branchAlreadyExists) {
    throw new CLIError(
      `Branch '${branch}' does not exist. Remove --no-create-branch to create it.`,
      EXIT_CODES.GENERAL_ERROR
    )
  }

  const useExistingBranch = branchAlreadyExists || options.createBranch === false

  // ローカルには無いが origin には存在するブランチ (teammate の push 済みブランチ等) を
  // base_branch から新規作成して黙って shadow しない。origin/<branch> から
  // トラッキングブランチを作る (素の `git worktree add` の DWIM と同等の挙動)。
  const trackRemoteBranch = !useExistingBranch && remoteBranchExists(branch)

  if (useExistingBranch) {
    out(`ℹ️  Branch '${branch}' already exists, using existing branch`)
  } else if (trackRemoteBranch) {
    out(
      `ℹ️  Branch '${branch}' exists on origin — creating local tracking branch from origin/${branch}`
    )
  } else {
    out(`✨ Creating new branch: ${branch}`)
  }

  // 設定ファイルを先に読み込み（base_branch を worktree 作成前に取得するため）
  const config = loadConfig(gitRoot)

  // relocatability preflight (warnings only, never throws)
  runRelocatabilityPreflight(gitRoot, config)

  // --seed の前提条件チェック (worktree を作る前に弾く)。
  const seedCommand = config.volumes?.seed_command
  if (useSeed) {
    if (!seedCommand || seedCommand.trim() === "") {
      throw new CLIError(
        "--seed requires `volumes.seed_command` to be set in wtb.yaml (the command that seeds a fresh DB in the worktree)",
        EXIT_CODES.CONFIG_ERROR
      )
    }
    if (forceVolumeCopy) {
      throw new CLIError(
        "--seed and --force-volume-copy are mutually exclusive: --seed skips volume cloning entirely and seeds fresh data instead",
        EXIT_CODES.GENERAL_ERROR
      )
    }
  }

  // 新規ブランチを base_branch から切る場合は、base_branch が解決できることを先に検証する。
  // branchExists は refs/heads/ しか見ないので、タグ/SHA/remote ref も許容する
  // rev-parse --verify <base>^{commit} ベースの revisionExists を使う。
  // 検証しないと `git worktree add` の奥で生の git エラーになり、wtb のデフォルト
  // base_branch ('main') が原因だと気付けない (default branch が 'master' のリポジトリ等)。
  if (!useExistingBranch && !trackRemoteBranch && !revisionExists(config.base_branch)) {
    throw new CLIError(
      `base_branch '${config.base_branch}' does not resolve in this repository. wtb defaults to 'main' when no wtb.yaml is present — set base_branch in wtb.yaml (e.g. 'master').`,
      EXIT_CODES.GENERAL_ERROR
    )
  }

  // worktreeを作成（新規ブランチの場合は base_branch を使用）
  if (dryRun) {
    out(`  [dry-run] Would create worktree at ${worktreePath}`)
  } else {
    createWorktree(branch, worktreePath, {
      useExistingBranch,
      baseBranch: useExistingBranch || trackRemoteBranch ? undefined : config.base_branch,
      trackFrom: trackRemoteBranch ? `origin/${branch}` : undefined,
    })
  }

  // --json 用の各 phase の結果トラッカー
  let envChanges: Record<string, { from: string; to: string }> = {}
  let composePorts: ComposePortChanges = {}
  let composeIdentity: ComposeIdentityRewrite = { containerNames: [] }
  let composeValueChanges: ComposeValueChange[] = []
  let volumeResult: VolumeCopyResult = emptyVolumeCopyResult()
  let startCommandFailed = false
  let composeFailed = false

  // link_files に含まれるパスはコピーをスキップしてシンボリックリンクを優先する
  const linkFileSet = new Set(config.link_files ?? [])
  const filesToCopy = (config.copy_files ?? []).filter((p) => !linkFileSet.has(p))

  // File copying phase
  if (filesToCopy.length > 0) {
    out("")
    if (skipCopy) {
      out("⏭️  Skipping file copy (--no-copy)")
    } else if (dryRun) {
      out(`📋 Would copy files: ${filesToCopy.join(", ")}`)
    } else {
      out("📋 Copying files/directories...")
      await copyConfiguredFiles(gitRoot, worktreePath, filesToCopy)
    }
  }

  // Symlink phase
  const linkFiles = config.link_files ?? []
  if (linkFiles.length > 0) {
    out("")
    if (skipLink) {
      out("⏭️  Skipping symlink creation (--no-link)")
    } else if (dryRun) {
      out(`🔗 Would create symlinks: ${linkFiles.join(", ")}`)
    } else {
      out("🔗 Creating symlinks...")
      await linkConfiguredFiles(gitRoot, worktreePath, linkFiles)
    }
  }

  // Environment file phase
  if (config.env.file.length > 0) {
    out("")
    if (skipEnv) {
      out("⏭️  Skipping environment file processing (--no-env)")
    } else if (dryRun) {
      const mode = Object.keys(config.env.adjust).length > 0 ? "adjust" : "copy"
      out(`🔧 Would process environment files (${mode}): ${config.env.file.join(", ")}`)
    } else if (Object.keys(config.env.adjust).length > 0) {
      out("🔧 Adjusting environment files...")
      envChanges = await applyEnvAdjustments(gitRoot, worktreePath, config)
    } else {
      out("📋 Copying environment files...")
      await copyConfiguredFiles(gitRoot, worktreePath, config.env.file)
    }
  }

  // Docker Compose phase
  if (config.docker_compose_file) {
    out("")
    if (skipDocker) {
      out("⏭️  Skipping Docker Compose setup (--no-docker)")
    } else if (dryRun) {
      const sourceComposePath = path.resolve(gitRoot, config.docker_compose_file)
      if (existsSync(sourceComposePath)) {
        out(`🐳 Would configure Docker Compose: ${config.docker_compose_file}`)
      } else {
        out(`⚠️  Docker Compose source not found: ${config.docker_compose_file} (would skip)`)
      }
    } else {
      const composeResult = await setupDockerCompose(
        gitRoot,
        worktreePath,
        config,
        branch,
        envChanges
      )
      composePorts = composeResult.portChanges
      composeIdentity = composeResult.identity
      composeValueChanges = composeResult.composeValueChanges
      composeFailed = composeResult.failed
    }
  }

  // Data phase: either SEED (run a seed command, never touching the source volume)
  // or CLONE (auto-copy named compose volumes so e.g. PostgreSQL data carries over).
  // --seed replaces cloning entirely, so the source stack is never stopped.
  let volumeFailures = 0
  let seedFailed = false
  if (useSeed) {
    // seedCommand is guaranteed non-empty here (validated above).
    out("")
    if (dryRun) {
      out(`🌱 Would seed data instead of cloning volumes: ${seedCommand}`)
    } else {
      out(`🌱 Seeding data instead of cloning volumes: ${seedCommand}`)
      seedFailed = !(await executeSeedCommand(seedCommand as string, worktreePath))
    }
  } else if (config.docker_compose_file && !skipDocker) {
    out("")
    if (skipVolumeCopy) {
      out("⏭️  Skipping volume clone (--no-volume-copy)")
    } else if (dryRun) {
      previewVolumeCopy(gitRoot, config)
    } else {
      volumeResult = await setupVolumeCopy(gitRoot, worktreePath, config, {
        force: forceVolumeCopy,
        stop: options.stop,
      })
      volumeFailures = volumeResult.failed.length
    }
  }

  // start_command phase
  if (config.start_command) {
    out("")
    if (skipStart) {
      out("⏭️  Skipping start command (--no-start)")
    } else if (dryRun) {
      out(`🚀 Would run start command: ${config.start_command}`)
    } else {
      out(`🚀 Running start command: ${config.start_command}`)
      startCommandFailed = !(await executeStartCommand(config.start_command, worktreePath))
    }
  }

  // source スタックを停止したまま再開に失敗した = ユーザの稼働中環境が壊れた状態。
  // --strict の有無に関わらず非ゼロ終了 (DOCKER_ERROR) する。バナーの分岐にも使うので
  // ここで先に計算する。
  const sourceRestartFailed =
    volumeResult.sourceStack?.stopped === true && volumeResult.sourceStack?.restarted === false

  // 成功メッセージ
  out("")
  if (dryRun) {
    out("🔍 Dry run complete — no changes were made")
  } else {
    if (sourceRestartFailed) {
      // source 環境が DOWN のまま = "成功" バナーを出してはいけない。詳細な recovery
      // 行は下の sourceRestartFailed ブロックで出す。
      out(
        "❌ Worktree created, but the SOURCE Compose stack failed to restart — your source environment is DOWN. See below to recover it."
      )
    } else if (volumeFailures > 0) {
      // worktree itself is created, but its data isolation is incomplete. Make this
      // loud and machine-parsable so an autonomous agent doesn't treat it as clean.
      out(
        `⚠️  Worktree created, but ${volumeFailures} volume(s) FAILED to clone — this worktree's data is NOT fully isolated. See the errors above; re-run the clone after resolving them.`
      )
    } else if (seedFailed) {
      // Same contract as a volume-clone failure: worktree exists but its data is
      // not ready. Keep the signal loud and machine-parsable for autonomous agents.
      out(
        "⚠️  Worktree created, but the seed command FAILED — this worktree's data is NOT ready. See the error above; re-run the seed in the worktree after resolving it."
      )
    } else if (composeFailed) {
      // worktree は作られたが compose の identity/ポート分離に失敗した。`docker compose up`
      // が source と衝突しうるので、成功バナーを出さず machine-parsable に警告する。
      out(
        "⚠️  Worktree created, but Docker Compose setup FAILED — this worktree's compose is NOT isolated; 'docker compose up' may collide with the source stack. See the error above."
      )
    } else {
      out("🎉 Worktree created successfully!")
    }
    out("")
    out("Next steps:")
    out(`  cd ${worktreePath}`)
    out("  wtb ports --pretty   # see this worktree's assigned ports")
    out("  # Start working on your branch")

    out("")
    out("📋 Current worktrees:")
    const worktrees = listWorktrees()
    for (const wt of worktrees) {
      const isNew = wt.branch === branch
      out(`  ${isNew ? "→" : " "} ${wt.branch}: ${wt.path}`)
    }

    // Claude Code skill 未導入なら案内を 1 行だけ出す
    if (!existsSync(path.join(gitRoot, ".claude", "skills", "wtb"))) {
      out("")
      out('💡 Tip: Run "wtb init-claude" to let Claude Code auto-detect this worktree\'s ports.')
    }
  }

  // --json: stdout には JSON オブジェクトを 1 つだけ出力する (人間向け出力は stderr 済み)。
  if (json) {
    writeJsonResult({
      branch,
      path: worktreePath,
      created: !dryRun,
      existing: false,
      createdBranch: !dryRun && !useExistingBranch,
      dryRun,
      env: envChanges,
      composePorts,
      composeIdentity,
      composeValueChanges,
      volumes: volumeResult,
      sourceRestartFailed,
      seed: useSeed ? { ran: !dryRun, failed: seedFailed } : null,
      startCommand: config.start_command
        ? { ran: !dryRun && !skipStart, failed: startCommandFailed }
        : null,
      composeFailed,
      ok: volumeFailures === 0 && !seedFailed && !sourceRestartFailed && !composeFailed,
    })
  }

  // 再開失敗時は recovery コマンドを stderr に出す (human モード)。
  if (sourceRestartFailed && volumeResult.sourceStack?.recoverCommand) {
    out(
      `  ❌ The source Compose stack was stopped to clone volumes but FAILED to restart — your source environment is DOWN. Bring it back up manually:`
    )
    out(`     ${volumeResult.sourceStack.recoverCommand}`)
  }

  // exit code 解決 (即 process.exit せず process.exitCode を設定して JSON flush を保証):
  // - source 再開失敗は --strict 無関係に DOCKER_ERROR (5)
  // - --strict 時のデータ分離未達成 (volume/seed 失敗) は GENERAL_ERROR (1)
  if (!dryRun && sourceRestartFailed) {
    process.exitCode = EXIT_CODES.DOCKER_ERROR
  } else if (
    !dryRun &&
    options.strict === true &&
    (volumeFailures > 0 || seedFailed || composeFailed)
  ) {
    process.exitCode = EXIT_CODES.GENERAL_ERROR
  }
}

/**
 * --json 用の機械可読な結果オブジェクトを stdout に 1 つだけ書き込む。
 */
function writeJsonResult(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
}

/**
 * 設定ファイルで指定されたファイル/ディレクトリをworktreeにコピー
 */
async function copyConfiguredFiles(
  sourceRoot: string,
  targetRoot: string,
  copyFiles: string[]
): Promise<void> {
  for (const relativePath of copyFiles) {
    const sourcePath = path.resolve(sourceRoot, relativePath)
    const targetPath = path.resolve(targetRoot, relativePath)

    if (!existsSync(sourcePath)) {
      out(`  ⚠️  Skip (not found): ${relativePath}`)
      continue
    }

    try {
      const stat = statSync(sourcePath)

      if (stat.isDirectory()) {
        await fs.copy(sourcePath, targetPath, { overwrite: true })
        out(`  ✅ Copied directory: ${relativePath}`)
      } else {
        await fs.ensureDir(path.dirname(targetPath))
        await fs.copy(sourcePath, targetPath, { overwrite: true })
        out(`  ✅ Copied file: ${relativePath}`)
      }
    } catch (error) {
      out(`  ❌ Failed to copy ${relativePath}: ${getErrorMessage(error)}`)
    }
  }
}

/**
 * 設定ファイルで指定されたファイル/ディレクトリをworktreeにシンボリックリンクで張る
 */
async function linkConfiguredFiles(
  sourceRoot: string,
  targetRoot: string,
  linkFiles: string[]
): Promise<void> {
  for (const relativePath of linkFiles) {
    const sourcePath = path.resolve(sourceRoot, relativePath)
    const targetPath = path.resolve(targetRoot, relativePath)

    if (!existsSync(sourcePath)) {
      out(`  ⚠️  Skip (not found): ${relativePath}`)
      continue
    }

    try {
      await fs.ensureDir(path.dirname(targetPath))

      let targetExists = false
      try {
        lstatSync(targetPath)
        targetExists = true
      } catch {
        targetExists = false
      }

      if (targetExists) {
        let targetStat: ReturnType<typeof lstatSync>
        try {
          targetStat = lstatSync(targetPath)
        } catch {
          out(`  ❌ Failed to stat target ${relativePath}: cannot read target`)
          continue
        }

        if (targetStat.isSymbolicLink()) {
          const currentLink = readlinkSync(targetPath)
          if (currentLink === sourcePath) {
            out(`  ✅ Symlink already correct: ${relativePath}`)
            continue
          }
          await fs.remove(targetPath)
          out(`  🔄 Replacing symlink (was → ${currentLink}): ${relativePath}`)
        } else if (targetStat.isDirectory()) {
          await fs.remove(targetPath)
          out(`  🔄 Replacing existing directory with symlink: ${relativePath}`)
        } else {
          await fs.remove(targetPath)
          out(`  🔄 Replacing existing file with symlink: ${relativePath}`)
        }
      }

      symlinkSync(sourcePath, targetPath)
      out(`  ✅ Symlinked: ${relativePath} → ${sourcePath}`)
    } catch (error) {
      out(`  ❌ Failed to symlink ${relativePath}: ${getErrorMessage(error)}`)
    }
  }
}

/** POSIX シェル向けに単一引用符でクオートする (スペース/`$`/`;` を含むパスの安全な埋め込み)。 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * start_commandを実行
 *
 * @returns 成功したか (失敗しても worktree 作成自体は続行する)
 */
async function executeStartCommand(command: string, worktreePath: string): Promise<boolean> {
  try {
    const commandPath = path.resolve(worktreePath, command)
    // 昇格したパスは /bin/sh のコマンド文字列に埋まるので、スペース等を含んでも壊れない
    // ようクオートする。command そのものは (昇格しない場合) ユーザーの shell 式なので触らない。
    const actualCommand = existsSync(commandPath) ? shellQuote(commandPath) : command

    executeLifecycleCommand(actualCommand, worktreePath)
    out("  ✅ Start command completed successfully")
    return true
  } catch (error) {
    out(`  ⚠️  Start command failed: ${getErrorMessage(error)}`)
    out("  (Worktree was created, but start command had issues)")
    return false
  }
}

/**
 * --seed 用の seed コマンドを worktree 内で実行する。
 * start_command と同じく文字列をまず worktree 相対パスとして解決し、無ければ
 * そのままシェルへ渡す。戻り値は成功なら true、失敗なら false (呼び出し側が
 * 「データ未準備」のバナーを出すために使う)。
 *
 * @returns 実行に成功したか
 */
async function executeSeedCommand(command: string, worktreePath: string): Promise<boolean> {
  try {
    const commandPath = path.resolve(worktreePath, command)
    const actualCommand = existsSync(commandPath) ? shellQuote(commandPath) : command

    executeLifecycleCommand(actualCommand, worktreePath)
    out("  ✅ Seed command completed successfully")
    return true
  } catch (error) {
    out(`  ❌ Seed command failed: ${getErrorMessage(error)}`)
    return false
  }
}

/** setupDockerCompose の結果 (ポート remap + identity 書き換え)。 */
export interface SetupComposeResult {
  /** サービスごとの host ポート remap (original → adjusted) */
  portChanges: ComposePortChanges
  /** project name / container_name の書き換え内訳 (--json / ロギング用) */
  identity: ComposeIdentityRewrite
  /** env→compose ポート伝播による文字列値の書き換え内訳 (--json / ロギング用) */
  composeValueChanges: ComposeValueChange[]
  /** compose 書き換えが例外で中断された (worktree の compose が未分離のまま) */
  failed: boolean
}

/**
 * Docker Compose ファイルをworktreeにコピーし、identity (project/container 名) と
 * ポートを調整する。Docker が利用できない場合はポート調整なしで書き込む。
 *
 * source の compose を一度だけ読み、in-memory な config に対して
 * (1) identity 書き換え → (2) [F2 ポート伝播 挿入点] → (3) ポート調整 を適用し、
 * 最後に一度だけ worktree へ書き出す。
 *
 * @returns ポート remap と identity 書き換え内訳。調整なし/スキップ時は空。
 */
async function setupDockerCompose(
  gitRoot: string,
  worktreePath: string,
  config: WtbConfig,
  branch: string,
  envChanges: Record<string, { from: string; to: string }> = {}
): Promise<SetupComposeResult> {
  const portChanges: ComposePortChanges = {}
  const emptyIdentity: ComposeIdentityRewrite = { containerNames: [] }
  const composeValueChanges: ComposeValueChange[] = []
  if (!config.docker_compose_file) {
    return { portChanges, identity: emptyIdentity, composeValueChanges, failed: false }
  }

  const sourceComposePath = path.resolve(gitRoot, config.docker_compose_file)
  if (!existsSync(sourceComposePath)) {
    out(`⚠️  Docker Compose source not found: ${config.docker_compose_file} (skipped)`)
    return { portChanges, identity: emptyIdentity, composeValueChanges, failed: false }
  }

  const targetComposePath = path.resolve(worktreePath, config.docker_compose_file)

  // ターゲットに compose が既に存在しても (git 追跡ファイルは `git worktree add` で必ず
  // checkout される / copy_files でコピーされる) スキップしない。worktree ごとの
  // identity 分離・ポート伝播・ポート調整は、まさにその checkout 済みコピーを書き換えて
  // 初めて効く。canonical な source を読んで transform し、target を上書きする
  // (source は不変なので --exists-ok の再実行でも二重変換にならない)。

  let identity: ComposeIdentityRewrite = emptyIdentity
  let failed = false
  try {
    out("🐳 Configuring Docker Compose...")

    // source の compose を 1 度だけ読み、in-memory に transform を重ねて 1 度だけ書き出す。
    const sourceConfig = readComposeFile(sourceComposePath)

    // ── (1) identity 書き換え (per-worktree な project/container 名分離) ────────────
    const composeIdentity = config.compose ?? { isolate_name: true, container_name: "suffix" }
    let workingConfig = sourceConfig
    if (composeIdentity.isolate_name || composeIdentity.container_name !== "keep") {
      // 他 worktree の slug と衝突する場合は raw branch のハッシュで一意化する
      // (unicode/記号だけ違う別ブランチが同一 project slug に畳まれる事故を防ぐ)。
      const otherBranches = safeWorktreeBranches()
      const slug = uniqueProjectSlug(branch, otherBranches)
      const rewritten = rewriteComposeIdentity(workingConfig, {
        slug,
        isolateName: composeIdentity.isolate_name,
        containerNameMode: composeIdentity.container_name,
      })
      workingConfig = rewritten.config
      identity = rewritten.rewrite

      if (identity.projectName) {
        out(`  🏷️  Compose project: ${identity.projectName.from} → ${identity.projectName.to}`)
      }
      for (const cn of identity.containerNames) {
        if (cn.to === undefined) {
          out(
            `  🏷️  container_name stripped for service '${cn.service}' (was '${cn.from}'; compose will auto-generate)`
          )
        } else {
          out(`  🏷️  container_name (${cn.service}): ${cn.from} → ${cn.to}`)
        }
      }
    }

    // container_name: keep で固定名が残っている場合、2 つ目の worktree の `up` が衝突する。
    if (composeIdentity.container_name === "keep") {
      const fixedNamed = Object.entries(sourceConfig.services ?? {})
        .filter(
          ([, svc]) => typeof (svc as { container_name?: unknown }).container_name === "string"
        )
        .map(([name]) => name)
      if (fixedNamed.length > 0) {
        out(
          `  ⚠️  container_name: keep — services [${fixedNamed.join(", ")}] keep a FIXED container_name. A 2nd worktree's 'docker compose up' WILL collide on these names. Use container_name: suffix or strip to isolate.`
        )
      }
    }

    // ── (2) [F2 INSERTION POINT] ────────────────────────────────────────────────
    // env→compose のポート伝播を PRISTINE な (ポート未調整の) workingConfig に適用する。
    // workingConfig は既に identity 書き換え済みで、まだ書き出されていない (下の単一 write
    // が最終形を 1 度だけ書く)。adjustPortsInCompose の前に適用することで、両者が同じ
    // 文字列を奪い合わないようにする。
    const propagationEnabled = config.env.port_propagation?.compose === true
    const envChangeKeys = Object.keys(envChanges)
    if (propagationEnabled && envChangeKeys.length > 0) {
      // EnvAdjustmentChange[] 相当を再構築して PortMap を作る
      const portMap = buildPortMap(
        envChangeKeys.map((key) => ({
          key,
          from: envChanges[key].from,
          to: envChanges[key].to,
        }))
      )
      const propagated = propagatePortsInComposeValues(workingConfig, envChanges, portMap)
      workingConfig = propagated.config
      composeValueChanges.push(...propagated.changes)
      for (const change of propagated.changes) {
        out(`  🔁 compose ${change.location}: ${change.from} → ${change.to}`)
      }
    }

    // ── (3) ポート調整 (使用中ポートを避けて host ポートを bump) ──────────────────
    // used ポートの母集団を 3 つ union する。docker ps だけに頼ると、停止中の兄弟
    // worktree や env フェーズが既に採番したポートを見落として衝突する:
    //   (a) 実行中コンテナが publish 中のポート (docker ps)
    //   (b) 兄弟 worktree (source/main 含む) の compose ファイルの host ポート
    //       — 停止中でも衝突するので compose ファイルを直接読む
    //   (c) この worktree の env フェーズが今回採番した数値ポート (envChanges)
    //       — env と compose が同じホストポートを別サービスに割り当てないように
    const usedPorts: number[] = []
    // Docker が利用できない場合は getUsedPorts 内部で握りつぶされ空配列になる
    for (const p of getUsedPorts()) usedPorts.push(p)
    for (const p of collectWorktreeComposePorts(worktreePath, config)) usedPorts.push(p)
    for (const change of Object.values(envChanges)) {
      const p = Number.parseInt(change.to, 10)
      if (!Number.isNaN(p)) usedPorts.push(p)
    }

    const adjustedConfig = adjustPortsInCompose(workingConfig, usedPorts)

    // どの host ポートがどこへ remap されたかをサービス単位で表示・収集する。
    // adjustPortsInCompose は ports 配列の順序を保つので index で突き合わせる。
    // identity 書き換えは ports を触らないので、比較は workingConfig (=identity後) と
    // adjustedConfig の間で行う。
    for (const [serviceName, service] of Object.entries(workingConfig.services ?? {})) {
      const originalPorts = service.ports
      const adjustedPorts = adjustedConfig.services?.[serviceName]?.ports
      if (!Array.isArray(originalPorts) || !Array.isArray(adjustedPorts)) continue
      for (const [index, original] of originalPorts.entries()) {
        const adjusted = adjustedPorts[index]
        if (typeof original !== "string" || typeof adjusted !== "string") continue
        const originalParsed = parsePortMapping(original)
        const adjustedParsed = parsePortMapping(adjusted)
        if (!originalParsed || !adjustedParsed) continue
        if (originalParsed.hostPort === adjustedParsed.hostPort) continue
        if (!portChanges[serviceName]) {
          portChanges[serviceName] = []
        }
        portChanges[serviceName].push({
          from: originalParsed.hostPort,
          to: adjustedParsed.hostPort,
        })
      }
    }

    // M2: identity 書き換え・伝播・ポート調整のいずれも変化を生まなかった場合は、
    // 追跡ファイルを無意味に reformat / skip-worktree しない (checkout 済みのまま残す)。
    const changed =
      identity.projectName !== undefined ||
      identity.containerNames.length > 0 ||
      composeValueChanges.length > 0 ||
      Object.keys(portChanges).length > 0

    if (changed) {
      // ── 単一 write: 全 transform を適用し終えた最終形を 1 度だけ書き出す ──────────
      await fs.ensureDir(path.dirname(targetComposePath))
      writeComposeFile(targetComposePath, adjustedConfig)
      // compose が git 追跡ファイルの場合、worktree ごとの書き換えで dirty にならないよう
      // skip-worktree を立て、wtb の出力 sha を manifest に記録する (remove の dirty
      // チェック / git status 汚染 / 誤コミット防止 + ユーザー手編集の保護)。
      markWtbManagedFile(worktreePath, config.docker_compose_file)
      out(`  ✅ Docker Compose file configured: ${config.docker_compose_file}`)
      for (const [serviceName, changes] of Object.entries(portChanges)) {
        for (const { from, to } of changes) {
          out(`     ${serviceName}: ${from} → ${to}`)
        }
      }
    } else {
      out(
        `  ℹ️  Docker Compose unchanged (no identity/port/propagation rewrite needed): ${config.docker_compose_file}`
      )
    }

    // start_command がない場合は使い方を提案
    if (!config.start_command) {
      out("  ℹ️  Tip: Run 'docker compose up -d' in the worktree to start services")
    }
  } catch (error) {
    // 書き換えが途中で失敗した = worktree の compose が未分離のまま残る。exit code /
    // banner / --json に反映できるよう failed を立てて呼び出し側に伝える。
    failed = true
    out(
      `  ⚠️  Docker Compose setup FAILED (${getErrorMessage(error)}) — this worktree's compose is NOT isolated; a 'docker compose up' may collide with the source stack.`
    )
  }
  return { portChanges, identity, composeValueChanges, failed }
}

/**
 * dry-run 時の volume clone プレビュー。実 Docker は触らない。
 * `wtb reclone --dry-run` からも再利用する。
 */
export function previewVolumeCopy(gitRoot: string, config: WtbConfig): void {
  if (!config.docker_compose_file) return
  const sourceComposePath = path.resolve(gitRoot, config.docker_compose_file)
  if (!existsSync(sourceComposePath)) {
    out("📦 Would clone Docker volumes — but compose file not found, skipping")
    return
  }
  let composeConfig: ReturnType<typeof readComposeFile>
  try {
    composeConfig = readComposeFile(sourceComposePath)
  } catch {
    out("📦 Would clone Docker volumes — but compose file unreadable, skipping")
    return
  }
  const exclude = config.volumes?.exclude ?? []
  const cloneable = discoverCloneableVolumes(composeConfig, exclude)
  if (cloneable.length === 0) {
    out("📦 No volumes to clone (none defined in compose, all external, or all excluded)")
    return
  }
  out(`📦 Would clone ${cloneable.length} volume(s):`)
  for (const key of cloneable) {
    out(`    - ${key}`)
  }
}

/**
 * Compose の volumes セクションに定義された named volume を、source project から
 * target project (新 worktree) へ自動コピーする。
 *
 * - external な volume はスキップ (共有意図)
 * - config.volumes.exclude に含まれる key はスキップ
 * - source volume が存在しない、稼働中コンテナが使用中、target が既にデータ保持中
 *   の場合は警告してスキップ (force=true で強行可能。target 側はクリア後コピー)
 *
 * @internal exported for unit testing
 */
export async function setupVolumeCopy(
  gitRoot: string,
  worktreePath: string,
  config: WtbConfig,
  options: { force?: boolean; stop?: boolean }
): Promise<VolumeCopyResult> {
  if (!config.docker_compose_file) return emptyVolumeCopyResult()

  const sourceComposePath = path.resolve(gitRoot, config.docker_compose_file)
  if (!existsSync(sourceComposePath)) return emptyVolumeCopyResult()

  // source の compose を読む。target project / target volume の解決には worktree の
  // identity-rewrite 済みコピーを使う (compose phase が volume phase より前に走るので
  // 既に存在する)。読めなければ source config にフォールバック。
  let composeConfig: ReturnType<typeof readComposeFile>
  try {
    composeConfig = readComposeFile(sourceComposePath)
  } catch (error) {
    out(`📦 Volume clone skipped: cannot read compose file (${getErrorMessage(error)})`)
    return emptyVolumeCopyResult()
  }

  const exclude = config.volumes?.exclude ?? []
  const cloneable = discoverCloneableVolumes(composeConfig, exclude)
  if (cloneable.length === 0) {
    return emptyVolumeCopyResult() // nothing to copy — silent
  }

  // 作成する volume に付ける repo 識別ラベル (prune の repo スコープ用)。
  const repoLabel = repoVolumeLabel(gitRoot)

  // Compose の実際のプロジェクト名 (compose-spec 準拠) を解決する。
  // source は source config + gitRoot、target は worktree の identity-rewrite 済み
  // コピー + worktreePath から解決する (project 名が分離されているので別物になる)。
  const sourceProject = resolveComposeProjectName(composeConfig, gitRoot)
  const targetComposePath = path.resolve(worktreePath, config.docker_compose_file)
  let targetComposeConfig = composeConfig
  try {
    if (existsSync(targetComposePath)) {
      targetComposeConfig = readComposeFile(targetComposePath)
    }
  } catch {
    // worktree コピーが読めなければ source config にフォールバック
  }
  const targetProject = resolveComposeProjectName(targetComposeConfig, worktreePath)
  out("📦 Cloning Docker volumes...")

  const result = emptyVolumeCopyResult()

  // ── 防御ガード #1 (project レベル): source project === target project ──────────
  // 固定 `name:` や COMPOSE_PROJECT_NAME により両 project 名が一致すると、clone は
  // source volume を自分自身に上書きしてデータを破壊する (--force-volume-copy 経路)。
  // stop ロジックの前に全 cloneable を failed にして即 return する。
  if (sourceProject === targetProject) {
    out(
      `  ❌ Source and target Compose projects are identical ('${sourceProject}'). This usually means a fixed 'name:' in the compose file or a COMPOSE_PROJECT_NAME env var. Cloning would overwrite the source volume WITH ITSELF and destroy data — refusing.`
    )
    for (const key of cloneable) {
      result.failed.push({
        name: key,
        error: `source and target Compose project are identical ('${sourceProject}') — cloning would overwrite the source volume`,
      })
    }
    return result
  }

  // ── plan-before-stop: stop する前に全 cloneable volume を分類する ──────────────
  const stopEnabled = options.stop !== false
  const force = options.force === true
  const plan = planVolumeClones(
    cloneable,
    composeConfig,
    targetComposeConfig,
    sourceProject,
    targetProject,
    { force, stopEnabled }
  )

  // plan の skip を結果へ反映 (理由付き)。
  for (const entry of plan) {
    if (entry.action === "skip") {
      out(`  ⏭️  ${entry.key}: ${entry.reason ?? "skipped"}`)
      result.skipped.push({ name: entry.key, reason: entry.reason ?? "skipped" })
    }
  }

  const needsStop = plan.some((e) => e.action === "clone-after-stop")

  // SIGINT/SIGTERM (cli/index.ts の handler) は process.exit() で下の finally を
  // バイパスするため、prepend した signal handler でも source を復帰させる。
  let restartOnAbort: (() => void) | undefined
  const abortSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"]
  let stoppedStack = false

  // 停止した source スタックを堅牢に復帰する: composeStart → (失敗時) composeUp →
  // (両方失敗時) error と recover コマンドを記録する。パスはコピペで安全なようクオートする。
  const recoverCommand = `docker compose -f ${shellQuote(sourceComposePath)} -p ${shellQuote(sourceProject)} up -d`
  const restartSourceStack = (): { restarted: boolean; error?: string } => {
    try {
      composeStart(sourceComposePath, sourceProject, gitRoot)
      return { restarted: true }
    } catch {
      try {
        composeUp(sourceComposePath, sourceProject, gitRoot)
        return { restarted: true }
      } catch (error) {
        return { restarted: false, error: getErrorMessage(error) }
      }
    }
  }

  // ── stop は clone-after-stop が 1 件以上ある時だけ ─────────────────────────────
  if (needsStop) {
    out(
      "  ⏸️  Source Compose stack is running — stopping it to clone volumes safely (will restart after)..."
    )
    try {
      composeStop(sourceComposePath, sourceProject, gitRoot)
      stoppedStack = true
      restartOnAbort = () => {
        // SIGINT/SIGTERM で中断された: source を復帰してから、その結果をユーザーに伝える
        // (無言で終わると source が DOWN のままか復帰したのか分からない)。
        out("")
        out("  ⚠️  Interrupted — restarting the source Compose stack before exit...")
        const r = restartSourceStack()
        if (r.restarted) {
          out("  ✅ Source stack restarted")
        } else {
          out(`  ⚠️  Failed to restart source stack: ${r.error}`)
          out(`     Your source environment is DOWN. Bring it back up manually: ${recoverCommand}`)
        }
      }
      for (const sig of abortSignals) {
        process.prependListener(sig, restartOnAbort)
      }
    } catch (error) {
      out(
        `  ⚠️  Could not stop source stack (${getErrorMessage(error)}) — clone-after-stop volumes will be skipped`
      )
      // 停止できなかったので、clone-after-stop だった entry を skip に降格する。
      for (const entry of plan) {
        if (entry.action === "clone-after-stop") {
          entry.action = "skip"
          entry.reason = "could not stop source stack to clone a live source volume"
          result.skipped.push({ name: entry.key, reason: entry.reason })
        }
      }
    }
  }

  try {
    for (const entry of plan) {
      if (entry.action === "skip") continue // 既に上で記録済み

      const { source, target } = entry

      // 停止後の in-use 再チェック (安全網): force でなく、まだ掴まれているなら skip。
      if (!force) {
        const usingContainers = getContainersUsingVolume(source.name)
        if (usingContainers.length > 0) {
          out(
            `  ⚠️  ${entry.key}: source volume '${source.name}' is still in use by ${usingContainers.join(", ")} after stopping — skipping`
          )
          result.skipped.push({
            name: entry.key,
            reason: "still in use after stopping the source stack",
          })
          continue
        }
      }

      // target データ判定 (空なら上書き OK)。getVolumeSize は確定できないと null。
      // null は「データがあるかも」として扱い、誤って上書きしない。
      let targetHadData = false
      if (volumeExists(target.name)) {
        const targetSize = getVolumeSize(target.name)
        const targetMayHaveData = targetSize === null || targetSize > 0
        if (targetMayHaveData) {
          // 既存データの上書きは --force-volume-copy のときだけ。plan 段階で非 force は
          // skip 済みだが、stop 後の TOCTOU で target がデータを得た場合に備え、ここでも
          // force を必須にする (force でなければ絶対に上書きしない)。
          if (!force) {
            out(
              `  ⏭️  ${entry.key}: target volume '${target.name}' gained data after planning — skipping (use --force-volume-copy to overwrite)`
            )
            result.skipped.push({
              name: entry.key,
              reason: "target volume already has data (appeared after planning)",
            })
            continue
          }
          // force でも、wtb が作成した volume でなければ無関係な既存 volume を消しかねない。
          // ラベル未確認 (wtb.managed≠true) の volume は上書きせず fail させ、判断を委ねる。
          if (!volumeIsWtbManaged(target.name)) {
            out(
              `  ❌ ${entry.key}: target volume '${target.name}' has data but is NOT wtb-managed — refusing to overwrite an unrelated volume even with --force-volume-copy. Rename or remove it manually.`
            )
            result.failed.push({
              name: entry.key,
              error: `target volume '${target.name}' has data but is not wtb-managed — refusing to overwrite`,
            })
            continue
          }
          targetHadData = true
        }
      }

      try {
        await copyVolume(source.name, target.name, {
          onProgress: createVolumeCopyProgressHandler(`  📦 ${entry.key}`),
          clearTarget: targetHadData,
          repoLabel,
        })
        out(`  ✅ Cloned ${source.name} → ${target.name}`)
        result.cloned.push(entry.key)
      } catch (error) {
        out(`  ❌ Failed to clone ${entry.key}: ${getErrorMessage(error)}`)
        result.failed.push({ name: entry.key, error: getErrorMessage(error) })
      }
    }

    out(
      `  → ${result.cloned.length} volume(s) cloned, ${result.skipped.length} skipped, ${result.failed.length} failed`
    )
  } finally {
    if (restartOnAbort) {
      for (const sig of abortSignals) {
        process.removeListener(sig, restartOnAbort)
      }
    }
    if (stoppedStack) {
      out("  ▶️  Restarting source Compose stack...")
      const restart = restartSourceStack()
      if (restart.restarted) {
        out("  ✅ Source stack restarted")
        result.sourceStack = { stopped: true, restarted: true }
      } else {
        out(`  ⚠️  Failed to restart source stack: ${restart.error}`)
        out(`     Bring it back up manually: ${recoverCommand}`)
        result.sourceStack = {
          stopped: true,
          restarted: false,
          restartError: restart.error,
          recoverCommand,
        }
      }
    }
  }

  return result
}

/** plan-before-stop が分類する各 volume の処理。 */
type CloneAction = "clone" | "clone-after-stop" | "skip"

/** plan-before-stop の 1 volume 分の判定結果。 */
interface VolumeClonePlanEntry {
  key: string
  action: CloneAction
  reason?: string
  source: ResolvedVolume
  target: ResolvedVolume
}

/**
 * source スタックを停止する前に、各 cloneable volume を分類する純粋な計画ステップ。
 *
 * これにより「全 volume が skip されるのに source スタックだけ無駄に停止される」という
 * リグレッションを防ぎ、別 Compose project が掴む volume を検出して source を止めずに
 * skip できる。
 *
 * 判定順 (全て stop 前に評価):
 * 1. source volume 不在 → skip
 * 2. source.name === target.name (固定共有名) → skip (external 相当)
 * 3. target にデータあり (size null or >0) AND !force → skip
 * 4. 稼働中コンテナ (project 付き):
 *    - 全 holder が sourceProject → clone-after-stop (stopEnabled && !force) else skip
 *    - foreign holder (project !== sourceProject, null 含む) あり → 停止せず skip
 * 5. それ以外 → clone
 *
 * @internal exported for unit testing
 */
export function planVolumeClones(
  cloneable: string[],
  composeConfig: ComposeConfig,
  targetComposeConfig: ComposeConfig,
  sourceProject: string,
  targetProject: string,
  opts: { force: boolean; stopEnabled: boolean }
): VolumeClonePlanEntry[] {
  const plan: VolumeClonePlanEntry[] = []

  for (const key of cloneable) {
    const source = resolveVolumeName(composeConfig, key, sourceProject)
    const target = resolveVolumeName(targetComposeConfig, key, targetProject)
    if (!source || !target) continue // external は discover で弾かれている想定
    if (source.external) continue

    // 1. source 不在
    if (!volumeExists(source.name)) {
      plan.push({
        key,
        action: "skip",
        reason: "source volume does not exist yet",
        source,
        target,
      })
      continue
    }

    // 2. 固定共有名 (source.name === target.name) → skip (external 同様 clone しない)
    if (source.name === target.name) {
      plan.push({
        key,
        action: "skip",
        reason: "volume has a fixed name shared across projects — not cloned",
        source,
        target,
      })
      continue
    }

    // 3. target にデータあり AND !force → skip
    if (!opts.force && volumeExists(target.name)) {
      const targetSize = getVolumeSize(target.name)
      if (targetSize === null || targetSize > 0) {
        plan.push({
          key,
          action: "skip",
          reason:
            targetSize === null
              ? "target volume size could not be determined"
              : "target volume already has data",
          source,
          target,
        })
        continue
      }
    }

    // 4. 稼働中コンテナ (project 付き)
    const holders = getContainersUsingVolumeWithProject(source.name)
    if (holders.length > 0) {
      const foreign = holders.filter((h) => h.project !== sourceProject)
      if (foreign.length > 0) {
        // foreign holder あり → source を止めても解放されないので停止せず skip
        const proj = foreign[0].project ?? "unknown"
        plan.push({
          key,
          action: "skip",
          reason: `held by another Compose project '${proj}' — stopping the source stack won't free it`,
          source,
          target,
        })
        continue
      }
      // 全 holder が sourceProject
      if (opts.force) {
        // force は live-copy する (停止不要)
        plan.push({ key, action: "clone", source, target })
        continue
      }
      if (opts.stopEnabled) {
        plan.push({ key, action: "clone-after-stop", source, target })
      } else {
        plan.push({
          key,
          action: "skip",
          reason: "source volume is in use by a running container (--no-stop)",
          source,
          target,
        })
      }
      continue
    }

    // 5. それ以外 → clone
    plan.push({ key, action: "clone", source, target })
  }

  return plan
}

/** 他 worktree のブランチ名を安全に取得する (listWorktrees が throw しても [])。 */
function safeWorktreeBranches(): string[] {
  try {
    return listWorktrees()
      .map((w) => w.branch)
      .filter((b): b is string => typeof b === "string" && b.length > 0)
  } catch {
    return []
  }
}

/**
 * 既存の各 worktree (main/source を含む) の compose ファイルから、既に割り当て済みの
 * host ポートを収集する。停止中の兄弟 worktree は docker ps に出ないが同じ host ポートを
 * 予約しているので、compose ファイルを直接読んで衝突回避の母集団に加える。target worktree
 * は自分がこれから書き込むので除外する。
 */
function collectWorktreeComposePorts(targetRoot: string, config: WtbConfig): number[] {
  if (!config.docker_compose_file) return []
  const ports: number[] = []
  const resolvedTarget = path.resolve(targetRoot)
  try {
    for (const wt of listWorktrees()) {
      if (path.resolve(wt.path) === resolvedTarget) continue
      const composePath = path.resolve(wt.path, config.docker_compose_file)
      if (!existsSync(composePath)) continue
      try {
        const cfg = readComposeFile(composePath)
        for (const svc of Object.values(cfg.services ?? {})) {
          if (!Array.isArray(svc.ports)) continue
          for (const entry of svc.ports) {
            if (typeof entry !== "string") continue
            const parsed = parsePortMapping(entry)
            if (parsed) ports.push(parsed.hostPort)
          }
        }
      } catch {
        // ignore unreadable / invalid sibling compose
      }
    }
  } catch {
    // ignore worktree listing errors (e.g. not in git repo)
  }
  return ports
}

/**
 * 既存の各 worktree (main/source を含む) の環境変数ファイルから、既に使われている
 * ポート番号を収集する（数値調整キーに対応するポートのみ）。
 *
 * source(main) も必ず含めること: main の起動中サービスは自分のポートを占有している
 * ため、新 worktree がそれらと**別キー間で**衝突しないよう避ける必要がある。例えば
 * source が APP_PORT=3000 / DB_PORT=3001 のように隣接ポートを使う場合、source を除外
 * すると新 worktree の APP が 3001 に bump して source の DB と衝突する。target だけ
 * を除外する (まだポート未確定 / これから書き込むため)。
 */
function collectWorktreeEnvPorts(targetRoot: string, config: WtbConfig): number[] {
  const adjustedKeys = new Set(
    Object.entries(config.env.adjust)
      .filter(([, v]) => typeof v === "number")
      .map(([k]) => k)
  )

  if (adjustedKeys.size === 0) return []

  const usedPorts: number[] = []
  const resolvedTarget = path.resolve(targetRoot)

  try {
    const worktrees = listWorktrees()
    for (const worktree of worktrees) {
      const resolvedPath = path.resolve(worktree.path)
      // target だけ除外 (これから書き込むため)。source(main) を含む他の全 worktree の
      // ポートは衝突回避の対象。
      if (resolvedPath === resolvedTarget) continue

      for (const relativePath of config.env.file) {
        const envPath = path.resolve(worktree.path, relativePath)

        try {
          const parsed = parseEnvFile(envPath)
          for (const entry of parsed.entries) {
            if (adjustedKeys.has(entry.key)) {
              const port = parseInt(entry.value, 10)
              if (!Number.isNaN(port)) {
                usedPorts.push(port)
              }
            }
          }
        } catch {
          // ignore errors reading individual worktree env files
        }
      }
    }
  } catch {
    // ignore worktree listing errors (e.g. not in git repo)
  }

  return usedPorts
}

/**
 * env.fileに記載された環境変数ファイルをworktreeにコピーしenv.adjustを適用
 *
 * @returns 変更されたキーごとの from/to (例: APP_PORT: 3000 → 3001)。--json の env フィールドにも使う。
 */
export async function applyEnvAdjustments(
  sourceRoot: string,
  targetRoot: string,
  config: WtbConfig
): Promise<Record<string, { from: string; to: string }>> {
  // 他の全 worktree (main 含む) で使用中のポートを収集（衝突防止）
  const usedPorts = collectWorktreeEnvPorts(targetRoot, config)
  // Docker が publish しているポートも除外する（docker ps から取得、失敗時は無視）
  try {
    for (const p of getUsedPorts()) usedPorts.push(p)
  } catch {
    // docker unavailable — degrade silently
  }
  const allChanges: Record<string, { from: string; to: string }> = {}
  // pass 1 で env.adjust により直接書き換えられたキー。pass 2 はこれらの値を
  // 伝播で上書きしてはいけない（自分自身を二重に書き換えてしまう）。
  const directlyAdjustedKeys = new Set<string>()
  // pass 1 の累積 changes（propagation-only ファイル用の union map に使う）。
  const allEnvAdjustmentChanges: EnvAdjustmentChange[] = []
  // M7: pass 1 で各 env.file ごとに実際に適用した bump を記録する。pass 2 の伝播は
  // 「そのファイル自身の bump から作った port map」を使う。同じキー (例 APP_PORT) が
  // 2 つの env.file に現れて独立に bump されても (file A は 3001、file B は 3002)、
  // flat な last-write-wins map で file A の埋め込みポートが file B の値に伝播する
  // バグを防ぐ (各ファイルは自分の bump に従う)。
  const changesByTarget = new Map<string, EnvAdjustmentChange[]>()
  // pass 1 でコピー済みの target ファイル（pass 2 で再コピーを避ける）。
  const copiedTargets = new Set<string>()

  // ── Pass 1: 既存挙動（env.file ごとに copyAndAdjustEnvFile） ──────────────────
  for (const relativePath of config.env.file) {
    const sourcePath = path.resolve(sourceRoot, relativePath)
    const targetPath = path.resolve(targetRoot, relativePath)

    if (!existsSync(sourcePath)) {
      out(`  ⚠️  Skip (not found): ${relativePath}`)
      continue
    }

    try {
      await fs.ensureDir(path.dirname(targetPath))
      const changes: EnvAdjustmentChange[] = []
      const adjustedCount = copyAndAdjustEnvFile(
        sourcePath,
        targetPath,
        config.env.adjust,
        undefined,
        usedPorts,
        changes
      )
      copiedTargets.add(path.resolve(targetPath))
      changesByTarget.set(path.resolve(targetPath), changes)
      out(`  ✅ Applied ${adjustedCount} adjustment(s): ${relativePath}`)
      for (const change of changes) {
        out(`     ${change.key}: ${change.from} → ${change.to}`)
        allChanges[change.key] = { from: change.from, to: change.to }
        allEnvAdjustmentChanges.push(change)
        directlyAdjustedKeys.add(change.key)
        // このファイルが採番したポートを共有 usedPorts に予約する。copyAndAdjustEnvFile は
        // usedPorts のローカルコピーで採番するため、押し戻さないと次の env.file が同じ
        // ポートを別サービスに割り当ててしまう (同一 worktree 内の衝突)。
        const toPort = Number.parseInt(change.to, 10)
        if (!Number.isNaN(toPort)) usedPorts.push(toPort)
      }
    } catch (error) {
      out(`  ❌ Failed to adjust ${relativePath}: ${getErrorMessage(error)}`)
    }
  }

  // ── Pass 2: ポート伝播（enabled かつ map が非空のときのみ） ───────────────────
  // env.adjust で変更されたポートを、直接調整されなかったキーの値（URL 等）に
  // 伝播させる。CRITICAL: 新値は常に SOURCE テキストから 1 パスの map で導出し、
  // 既に書き換え済みの target テキストからは導出しない（A→B の二重マップ防止）。
  const propagation = config.env.port_propagation
  if (propagation?.enabled) {
    // propagation-only ファイル (env.file ではないが propagation.files に載るファイル)
    // は自分自身の bump を持たないので、全 env.file の bump を集めた union map に従う。
    const unionMap = buildPortMap(allEnvAdjustmentChanges)
    const envFileSet = new Set(config.env.file)
    if (unionMap.size > 0) {
      const filesToPropagate = Array.from(new Set([...config.env.file, ...propagation.files]))

      for (const relativePath of filesToPropagate) {
        const sourcePath = path.resolve(sourceRoot, relativePath)
        const targetPath = path.resolve(targetRoot, relativePath)
        const resolvedTarget = path.resolve(targetPath)

        // M7: env.file は「そのファイル自身の pass-1 bump」から作った map を使う。
        // propagation-only ファイルは union map を使う (自分の bump を持たないため)。
        const portMap = envFileSet.has(relativePath)
          ? buildPortMap(changesByTarget.get(resolvedTarget) ?? [])
          : unionMap

        if (!existsSync(sourcePath)) {
          // propagation.files のみに載っていて source が無いケースは静かにスキップ。
          if (!config.env.file.includes(relativePath)) {
            out(`  ⚠️  Skip propagation (source not found): ${relativePath}`)
          }
          continue
        }

        // このファイル固有の map が空なら伝播対象が無いのでスキップ。
        if (portMap.size === 0) continue

        try {
          // propagation 専用ファイル（pass 1 でコピーされていない）は先に source→target
          // をそのままコピーする。env.adjust の bump は適用しない（伝播のみ受ける）。
          if (!copiedTargets.has(resolvedTarget)) {
            await fs.ensureDir(path.dirname(targetPath))
            await fs.copy(sourcePath, targetPath)
            copiedTargets.add(resolvedTarget)
          }

          const source = parseEnvFile(sourcePath)
          const target = parseEnvFile(targetPath)
          // source の key→value ルックアップ（target の値は SOURCE から導出するため）。
          const sourceValueByKey = new Map(source.entries.map((e) => [e.key, e.value]))

          let propagated = 0
          for (const line of target.lines) {
            if (line.type !== "entry") continue
            // pass 1 で直接調整されたキーは伝播対象外（自己二重書き換え防止）。
            if (directlyAdjustedKeys.has(line.key)) continue
            const sourceValue = sourceValueByKey.get(line.key)
            if (sourceValue === undefined) continue
            const { value: newValue, hits } = propagatePortsInValue(sourceValue, portMap)
            if (hits.length === 0 || newValue === line.value) continue
            out(`     ${line.key}: ${line.value} → ${newValue}`)
            line.value = newValue
            // entries 配列も同期
            const entry = target.entries.find((e) => e.key === line.key)
            if (entry) entry.value = newValue
            // --json の env フィールドへ追加（additive）。
            allChanges[line.key] = { from: sourceValue, to: newValue }
            propagated++
          }

          if (propagated > 0) {
            writeEnvFile(targetPath, target)
            out(`  🔁 Propagated ${propagated} port reference(s): ${relativePath}`)
          }
        } catch (error) {
          out(`  ❌ Failed to propagate ${relativePath}: ${getErrorMessage(error)}`)
        }
      }
    }
  }

  // wtb が worktree に書き出した env ファイルが git 追跡なら skip-worktree を立てる。
  // 追跡ファイルへの調整は worktree を dirty にし、remove の dirty チェックや
  // `git worktree remove` を誤発火させ、ユーザーの git status を汚す。
  for (const relativePath of new Set([
    ...config.env.file,
    ...(config.env.port_propagation?.files ?? []),
  ])) {
    if (copiedTargets.has(path.resolve(targetRoot, relativePath))) {
      markWtbManagedFile(targetRoot, relativePath)
    }
  }

  return allChanges
}
