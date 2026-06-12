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
  composeStart,
  composeStop,
  parsePortMapping,
  readComposeFile,
  resolveComposeProjectName,
  writeComposeFile,
} from "../../core/docker/compose.js"
import {
  copyVolume,
  discoverCloneableVolumes,
  getContainersUsingVolume,
  getVolumeSize,
  resolveVolumeName,
  volumeExists,
} from "../../core/docker/volume.js"
import {
  copyAndAdjustEnvFile,
  type EnvAdjustmentChange,
  parseEnvFile,
} from "../../core/environment/processor.js"
import {
  branchExists,
  getGitRootOrThrow,
  remoteBranchExists,
  revisionExists,
} from "../../core/git/repository.js"
import { createWorktree, getWorktreePath, listWorktrees } from "../../core/git/worktree.js"
import type { WtbConfig } from "../../types/index.js"
import { CLIError, getErrorMessage } from "../../utils/error.js"
import { executeLifecycleCommand } from "../../utils/exec.js"
import { out, setJsonOutputMode } from "../../utils/output.js"
import { withErrorHandling } from "../utils/command-helpers.js"
import { createVolumeCopyProgressHandler } from "../utils/progress.js"

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
  let volumeResult: VolumeCopyResult = emptyVolumeCopyResult()
  let startCommandFailed = false

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
      composePorts = await setupDockerCompose(gitRoot, worktreePath, config)
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

  // 成功メッセージ
  out("")
  if (dryRun) {
    out("🔍 Dry run complete — no changes were made")
  } else {
    if (volumeFailures > 0) {
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
      volumes: volumeResult,
      seed: useSeed ? { ran: !dryRun, failed: seedFailed } : null,
      startCommand: config.start_command
        ? { ran: !dryRun && !skipStart, failed: startCommandFailed }
        : null,
      ok: volumeFailures === 0 && !seedFailed,
    })
  }

  // --strict: worktree は作成済みでも、データ分離が未達成 (volume クローン失敗 / seed 失敗)
  // なら非ゼロ終了する。既定 (exit 0) は「worktree は存在する」契約を維持しつつ、CI や
  // コーディングエージェントが失敗を確実に検知できるオプトインの経路を提供する。
  // JSON モードでは payload を書き切ってから exitCode のみ設定する (prune と同じ理由:
  // 即 process.exit すると stdout の flush 前に落ちて JSON が壊れる恐れがある)。
  if (!dryRun && options.strict === true && (volumeFailures > 0 || seedFailed)) {
    if (json) {
      process.exitCode = EXIT_CODES.GENERAL_ERROR
    } else {
      process.exit(EXIT_CODES.GENERAL_ERROR)
    }
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

/**
 * start_commandを実行
 *
 * @returns 成功したか (失敗しても worktree 作成自体は続行する)
 */
async function executeStartCommand(command: string, worktreePath: string): Promise<boolean> {
  try {
    const commandPath = path.resolve(worktreePath, command)
    const actualCommand = existsSync(commandPath) ? commandPath : command

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
    const actualCommand = existsSync(commandPath) ? commandPath : command

    executeLifecycleCommand(actualCommand, worktreePath)
    out("  ✅ Seed command completed successfully")
    return true
  } catch (error) {
    out(`  ❌ Seed command failed: ${getErrorMessage(error)}`)
    return false
  }
}

/**
 * Docker Compose ファイルをworktreeにコピーし、ポートを調整する
 * Docker が利用できない場合は無調整でコピーする
 *
 * @returns サービスごとの host ポート remap (original → adjusted)。調整なし/スキップ時は空。
 */
async function setupDockerCompose(
  gitRoot: string,
  worktreePath: string,
  config: WtbConfig
): Promise<ComposePortChanges> {
  const portChanges: ComposePortChanges = {}
  if (!config.docker_compose_file) return portChanges

  const sourceComposePath = path.resolve(gitRoot, config.docker_compose_file)
  if (!existsSync(sourceComposePath)) {
    out(`⚠️  Docker Compose source not found: ${config.docker_compose_file} (skipped)`)
    return portChanges
  }

  const targetComposePath = path.resolve(worktreePath, config.docker_compose_file)

  // ターゲットに既にファイルが存在する場合はスキップ（start_command 等でコピー済みの場合）
  if (existsSync(targetComposePath)) return portChanges

  try {
    out("🐳 Configuring Docker Compose...")

    const composeConfig = readComposeFile(sourceComposePath)

    // 実行中のコンテナのポートを取得してポート衝突を避ける
    // Docker が利用できない場合は空配列になる（エラーは無視）
    let usedPorts: number[] = []
    try {
      usedPorts = getUsedPorts()
    } catch {
      // Docker が利用できない場合はポート調整なし
    }

    const adjustedConfig = adjustPortsInCompose(composeConfig, usedPorts)
    await fs.ensureDir(path.dirname(targetComposePath))
    writeComposeFile(targetComposePath, adjustedConfig)
    out(`  ✅ Docker Compose file configured: ${config.docker_compose_file}`)

    // どの host ポートがどこへ remap されたかをサービス単位で表示・収集する。
    // adjustPortsInCompose は ports 配列の順序を保つので index で突き合わせる。
    for (const [serviceName, service] of Object.entries(composeConfig.services ?? {})) {
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
        out(`     ${serviceName}: ${originalParsed.hostPort} → ${adjustedParsed.hostPort}`)
      }
    }

    // start_command がない場合は使い方を提案
    if (!config.start_command) {
      out("  ℹ️  Tip: Run 'docker compose up -d' in the worktree to start services")
    }
  } catch (error) {
    out(`  ⚠️  Docker Compose setup skipped: ${getErrorMessage(error)}`)
  }
  return portChanges
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

  // Compose の実際のプロジェクト名 (compose-spec 準拠) を解決する。
  // `name:` が compose.yml に書かれていればそれを採用、なければディレクトリ名を
  // Compose の正規化規則で整形する。`generateProjectName` は仕様より厳しい
  // (underscore や dot をダッシュに置換) ため、ここでは使えない。
  const sourceProject = resolveComposeProjectName(composeConfig, gitRoot)
  const targetProject = resolveComposeProjectName(composeConfig, worktreePath)
  out("📦 Cloning Docker volumes...")

  // stop-then-copy: source volume を使う稼働中コンテナがあり、--no-stop でも
  // --force-volume-copy でもなければ、source スタックを停止してから安全にコピーし、
  // finally で必ず再開する。これで「DB が起動中だと clone が skip される」という
  // データ自律性のギャップ (README Roadmap) を解消する。
  const stopEnabled = options.stop !== false
  let stoppedStack = false
  // process.exit() (e.g. the SIGINT/SIGTERM handlers in cli/index.ts) bypasses the
  // finally below, so a Ctrl-C or kill mid-copy would leave the source stack down.
  // Restart it from prepended signal handlers too — they run before the index
  // handler exits. Both SIGINT (Ctrl-C) and SIGTERM (kill) are covered.
  let restartOnAbort: (() => void) | undefined
  const abortSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"]
  if (stopEnabled && !options.force) {
    const anyInUse = cloneable.some((key) => {
      const source = resolveVolumeName(composeConfig, key, sourceProject)
      return (
        !!source &&
        !source.external &&
        volumeExists(source.name) &&
        getContainersUsingVolume(source.name).length > 0
      )
    })
    if (anyInUse) {
      out(
        "  ⏸️  Source Compose stack is running — stopping it to clone volumes safely (will restart after)..."
      )
      try {
        composeStop(sourceComposePath, sourceProject, gitRoot)
        stoppedStack = true
        restartOnAbort = () => {
          try {
            composeStart(sourceComposePath, sourceProject, gitRoot)
          } catch {
            // best-effort restart on abort; nothing else we can do mid-signal
          }
        }
        for (const sig of abortSignals) {
          process.prependListener(sig, restartOnAbort)
        }
      } catch (error) {
        out(
          `  ⚠️  Could not stop source stack (${getErrorMessage(error)}) — falling back to per-volume skip`
        )
      }
    }
  }

  const result = emptyVolumeCopyResult()

  try {
    for (const key of cloneable) {
      const source = resolveVolumeName(composeConfig, key, sourceProject)
      const target = resolveVolumeName(composeConfig, key, targetProject)
      if (!source || !target) {
        // discoverCloneableVolumes が external を弾いているのでここには来ない想定
        continue
      }
      if (source.external) {
        // 念のためのガード
        continue
      }

      // source 存在チェック
      if (!volumeExists(source.name)) {
        out(`  ℹ️  ${key}: source volume '${source.name}' does not exist yet — skipping`)
        result.skipped.push({ name: key, reason: "source volume does not exist yet" })
        continue
      }

      // 稼働中コンテナチェック (Postgres などのライブコピーは破損リスク)。force でない
      // 限り、stoppedStack の有無に関わらず copy 直前に必ず再チェックする。これにより
      // (a) --no-stop 時のライブ source skip、(b) スタックを停止したのに別 Compose
      // project が共有名前付き volume を掴んでいて依然 in-use なケース、の両方を弾く。
      if (!options.force) {
        const usingContainers = getContainersUsingVolume(source.name)
        if (usingContainers.length > 0) {
          out(
            `  ⚠️  ${key}: source volume '${source.name}' is in use by ${usingContainers.join(", ")}`
          )
          out(
            stoppedStack
              ? "      → skipping: still in use after stopping the source stack (likely held by another Compose project sharing this named volume) — stop that side or pass --force-volume-copy"
              : "      → skipping (--no-stop set; stop the source stack manually, drop --no-stop to auto stop-then-copy, or pass --force-volume-copy to clone live with data-corruption risk)"
          )
          result.skipped.push({
            name: key,
            reason: stoppedStack
              ? "still in use after stopping the source stack"
              : "source volume is in use by a running container (--no-stop)",
          })
          continue
        }
      }

      // target に既にデータが入っているかチェック (空の volume ならコピーで上書き OK)。
      // getVolumeSize は確定できないと null を返す。null を「空」と誤認して上書き
      // しないよう、null は「データがあるかもしれない」として扱う。
      let targetHadData = false
      if (volumeExists(target.name)) {
        const targetSize = getVolumeSize(target.name)
        const targetMayHaveData = targetSize === null || targetSize > 0
        if (targetMayHaveData) {
          if (!options.force) {
            const reason =
              targetSize === null
                ? "size could not be determined — skipping (use --force-volume-copy to overwrite anyway)"
                : "already has data — skipping (use --force-volume-copy to overwrite)"
            out(`  ⚠️  ${key}: target volume '${target.name}' ${reason}`)
            result.skipped.push({
              name: key,
              reason:
                targetSize === null
                  ? "target volume size could not be determined"
                  : "target volume already has data",
            })
            continue
          }
          // force=true: 既存データを上書きする。clearTarget=true を渡すと copyVolume が
          // atomic 経路 (一時 volume にステージング→検証→target を置換) を使うので、
          // コピーが途中で失敗しても target の既存データが空になることはない。
          targetHadData = true
        }
      }

      try {
        await copyVolume(source.name, target.name, {
          onProgress: createVolumeCopyProgressHandler(`  📦 ${key}`),
          clearTarget: targetHadData,
        })
        out(`  ✅ Cloned ${source.name} → ${target.name}`)
        result.cloned.push(key)
      } catch (error) {
        out(`  ❌ Failed to clone ${key}: ${getErrorMessage(error)}`)
        result.failed.push({ name: key, error: getErrorMessage(error) })
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
      try {
        composeStart(sourceComposePath, sourceProject, gitRoot)
        out("  ✅ Source stack restarted")
      } catch (error) {
        out(`  ⚠️  Failed to restart source stack: ${getErrorMessage(error)}`)
        out(
          "     Bring it back up manually: 'docker compose start' (or 'up -d') in the source repo."
        )
      }
    }
  }

  return result
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
async function applyEnvAdjustments(
  sourceRoot: string,
  targetRoot: string,
  config: WtbConfig
): Promise<Record<string, { from: string; to: string }>> {
  // 他の全 worktree (main 含む) で使用中のポートを収集（衝突防止）
  const usedPorts = collectWorktreeEnvPorts(targetRoot, config)
  const allChanges: Record<string, { from: string; to: string }> = {}

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
      out(`  ✅ Applied ${adjustedCount} adjustment(s): ${relativePath}`)
      for (const change of changes) {
        out(`     ${change.key}: ${change.from} → ${change.to}`)
        allChanges[change.key] = { from: change.from, to: change.to }
      }
    } catch (error) {
      out(`  ❌ Failed to adjust ${relativePath}: ${getErrorMessage(error)}`)
    }
  }

  return allChanges
}
