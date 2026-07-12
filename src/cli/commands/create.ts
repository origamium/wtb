/**
 * @fileoverview Create コマンド実装
 * Git worktreeの作成を担当
 */

import { randomUUID } from "node:crypto"
import {
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
} from "node:fs"
import * as path from "node:path"
import { Command } from "commander"
import fs from "fs-extra"
import { EXIT_CODES } from "../../constants/index.js"
import { loadConfig } from "../../core/config/loader.js"
import { resolveRepositoryPath } from "../../core/config/paths.js"
import { getUsedPortsOrThrow } from "../../core/docker/client.js"
import {
  adjustPortsInCompose,
  assertComposeNetworkingSafe,
  assertNoComposeSourceOverrides,
  assertNoTransientComposeProjectOverride,
  assertComposeStorageDefinitionsSafe,
  type ComposeIdentityRewrite,
  type ComposeValueChange,
  composeStart,
  composeStop,
  composeUp,
  loadComposeInterpolationEnvironment,
  parsePortMapping,
  propagatePortsInComposeValues,
  readComposeFile,
  resolveComposeProjectNameForWorktree,
  rewriteComposeIdentity,
  uniqueProjectSlug,
  writeComposeFile,
} from "../../core/docker/compose.js"
import { interpolateComposeValue } from "../../core/docker/interpolation.js"
import {
  acquireTargetVolumeLifecycleLeases,
  acquireVolumeCloneOperationLock,
  copyVolume,
  discoverCloneableVolumes,
  getContainersUsingVolumeOrThrow,
  getContainersUsingVolumeWithProjectOrThrow,
  getVolumeRecoveryDirectory,
  preflightTargetVolumeForCopy,
  readVolumeRecoveryRecords,
  repoVolumeLabel,
  type ResolvedVolume,
  resolveVolumeName,
  type VolumeOwnership,
  volumeExistsOrThrow,
  WTB_VOLUME_LABELS,
  type TargetVolumeLifecycleLease,
} from "../../core/docker/volume.js"
import {
  assertComposeProjectUnique,
  assertDockerComposeProjectOwnedByWorktree,
} from "../../core/docker/project-ownership.js"
import {
  copyAndAdjustEnvFile,
  copyEnvFileAtomic,
  type EnvAdjustmentChange,
  parseEnvFile,
  writeEnvFile,
} from "../../core/environment/processor.js"
import { buildPortMap, propagatePortsInValue } from "../../core/environment/propagate.js"
import {
  acquireRepositoryLock,
  branchExists,
  getRepositoryContext,
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

export type SetupPhase = "copy" | "link" | "env" | "compose" | "start"

/** A non-fatal warning or an actual setup failure surfaced by `create --json`. */
export interface SetupIssue {
  phase: SetupPhase
  path?: string
  message: string
}

export interface SetupIssues {
  warnings: SetupIssue[]
  failures: SetupIssue[]
}

function emptySetupIssues(): SetupIssues {
  return { warnings: [], failures: [] }
}

function addSetupIssue(
  issues: SetupIssues,
  severity: "warning" | "failure",
  issue: SetupIssue
): void {
  if (severity === "warning") issues.warnings.push(issue)
  else issues.failures.push(issue)
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
   * source スタックの停止を試みた場合に設定する。`stopped` は stop コマンドが正常完了
   * したかを表す（false でも部分停止の可能性がある）。restarted=false なら、ユーザの
   * 稼働中環境が壊れたままなので、呼び出し側は非ゼロ終了し recoverCommand を出す。
   */
  sourceStack?: {
    stopped: boolean
    restarted: boolean
    /** `docker compose stop` が完了しなかった場合のエラー。部分停止の可能性がある。 */
    stopError?: string
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
      "Exit non-zero (1) if setup, volume cloning, seeding, or start_command fails (default: keep the worktree and exit 0)"
    )
    .option(
      "--exists-ok",
      "If a worktree for the branch already exists, print its path and exit 0 instead of failing"
    )
    .option(
      "--json",
      "Output one machine-readable JSON result, including setupWarnings/setupFailures, on stdout"
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

  const repository = getRepositoryContext()
  const gitRoot = repository.mainRoot
  const dryRun = options.dryRun === true
  let releaseRepositoryLock = dryRun ? undefined : await acquireRepositoryLock(repository)
  let targetLifecycleLease: TargetVolumeLifecycleLease | undefined

  try {
    // 既存のworktreeチェック
    const existingPath = getWorktreePath(branch, gitRoot)
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
            dryRun,
            setupWarnings: [],
            setupFailures: [],
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
    if (useSeed && skipDocker) {
      throw new CLIError(
        "--seed cannot be combined with --no-docker: the isolated target Compose stack must be configured and ownership-checked before seed_command can run",
        EXIT_CODES.GENERAL_ERROR
      )
    }
    if (dryRun) {
      out("🔍 Dry run mode — no changes will be made")
      out("")
    }

    out(`🌿 Creating worktree for branch: ${branch}`)
    out(`📂 Worktree path: ${worktreePath}`)

    // ブランチが既に存在するかチェック
    const branchAlreadyExists = branchExists(branch, gitRoot)

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
    const trackRemoteBranch = !useExistingBranch && remoteBranchExists(branch, "origin", gitRoot)

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
    if (!useExistingBranch && !trackRemoteBranch && !revisionExists(config.base_branch, gitRoot)) {
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
        cwd: gitRoot,
      })
    }

    // --json 用の各 phase の結果トラッカー
    let envChanges: Record<string, { from: string; to: string }> = {}
    let composePorts: ComposePortChanges = {}
    let composeIdentity: ComposeIdentityRewrite = { containerNames: [] }
    let composeValueChanges: ComposeValueChange[] = []
    let volumeResult: VolumeCopyResult = emptyVolumeCopyResult()
    let startCommandFailed = false
    let startCommandRan = false
    let composeFailed = false
    const setupIssues = emptySetupIssues()
    // One reservation set is shared by env and Compose allocation while the
    // repository lock is held by the caller. It includes stopped sibling
    // worktrees as well as Docker's currently published ports.
    const reservedPorts = new Set<number>()
    const needsPortReservations =
      (!skipEnv && Object.values(config.env.adjust).some((value) => typeof value === "number")) ||
      (!skipDocker && Boolean(config.docker_compose_file))
    let portReservationFailed = false
    if (!dryRun && needsPortReservations) {
      try {
        for (const port of collectWorktreeEnvPorts(worktreePath, config)) reservedPorts.add(port)
        for (const port of collectWorktreeComposePorts(worktreePath, config)) {
          reservedPorts.add(port)
        }
        if (!skipDocker) {
          for (const port of getUsedPortsOrThrow()) reservedPorts.add(port)
        }
      } catch (error) {
        portReservationFailed = true
        const message = `Could not build a complete repository-wide port reservation set: ${getErrorMessage(error)}`
        addSetupIssue(setupIssues, "failure", { phase: "env", message })
        out(`  ❌ ${message}`)
      }
    }

    // link_files に含まれるパスはコピーをスキップしてシンボリックリンクを優先する
    const linkFileSet = new Set<string>()
    for (const configuredPath of config.link_files ?? []) {
      try {
        linkFileSet.add(resolveRepositoryPath(gitRoot, configuredPath, { field: "link_files" }))
      } catch {
        // linkConfiguredFiles records the runtime validation failure in setupIssues.
      }
    }
    let composeSourcePath: string | null = null
    if (config.docker_compose_file) {
      try {
        composeSourcePath = resolveRepositoryPath(gitRoot, config.docker_compose_file, {
          field: "docker_compose_file source",
        })
      } catch {
        // setupDockerCompose records the runtime validation failure.
      }
    }

    const filesToCopy = (config.copy_files ?? []).filter((configuredPath) => {
      if (!skipCopy && !dryRun) {
        try {
          assertSetupSourceDoesNotContainWorktree(gitRoot, worktreePath, configuredPath, "copy")
        } catch (error) {
          const message = getErrorMessage(error)
          addSetupIssue(setupIssues, "failure", {
            phase: "copy",
            path: configuredPath,
            message,
          })
          out(`  ❌ Refusing unsafe copy source '${configuredPath}': ${message}`)
          return false
        }
      }
      let sourcePath: string
      try {
        sourcePath = resolveRepositoryPath(gitRoot, configuredPath, { field: "copy_files" })
      } catch {
        return true
      }
      if (linkFileSet.has(sourcePath)) return false
      // The dedicated Compose phase must see the branch checkout before deciding
      // whether to fall back to main; a generic copy here would overwrite it. With
      // --no-docker, preserve an already checked-out branch Compose as well, while
      // retaining the explicit copy_files fallback when the target file is absent.
      if (composeSourcePath === null || sourcePath !== composeSourcePath) return true
      if (!skipDocker) return false
      try {
        const targetComposePath = resolveRepositoryPath(
          worktreePath,
          config.docker_compose_file,
          { field: "docker_compose_file target", rejectSymlinkAncestors: true }
        )
        return !existsSync(targetComposePath)
      } catch {
        // Let copyConfiguredFiles surface a structured setup failure.
        return true
      }
    })

    // File copying phase
    if (filesToCopy.length > 0) {
      out("")
      if (skipCopy) {
        out("⏭️  Skipping file copy (--no-copy)")
      } else if (dryRun) {
        out(`📋 Would copy files: ${filesToCopy.join(", ")}`)
      } else {
        out("📋 Copying files/directories...")
        await copyConfiguredFiles(gitRoot, worktreePath, filesToCopy, setupIssues)
      }
    }

    // Symlink phase
    const linkFiles = (config.link_files ?? []).filter((configuredPath) => {
      if (skipLink || dryRun) return true
      try {
        assertSetupSourceDoesNotContainWorktree(gitRoot, worktreePath, configuredPath, "link")
        return true
      } catch (error) {
        const message = getErrorMessage(error)
        addSetupIssue(setupIssues, "failure", {
          phase: "link",
          path: configuredPath,
          message,
        })
        out(`  ❌ Refusing unsafe link source '${configuredPath}': ${message}`)
        return false
      }
    })
    if (linkFiles.length > 0) {
      out("")
      if (skipLink) {
        out("⏭️  Skipping symlink creation (--no-link)")
      } else if (dryRun) {
        out(`🔗 Would create symlinks: ${linkFiles.join(", ")}`)
      } else {
        out("🔗 Creating symlinks...")
        await linkConfiguredFiles(gitRoot, worktreePath, linkFiles, setupIssues)
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
      } else if (portReservationFailed && Object.keys(config.env.adjust).length > 0) {
        out("⏭️  Skipping environment port allocation because sibling reservations are incomplete")
      } else if (Object.keys(config.env.adjust).length > 0) {
        out("🔧 Adjusting environment files...")
        envChanges = await applyEnvAdjustments(gitRoot, worktreePath, config, {
          reservedPorts,
          issues: setupIssues,
        })
      } else {
        out("📋 Copying environment files...")
        await copyConfiguredFiles(gitRoot, worktreePath, config.env.file, setupIssues, "env")
      }
    }

    // Docker Compose phase
    if (config.docker_compose_file) {
      out("")
      if (skipDocker) {
        out("⏭️  Skipping Docker Compose setup (--no-docker)")
      } else if (dryRun) {
        const sourceComposePath = resolveRepositoryPath(gitRoot, config.docker_compose_file, {
          field: "docker_compose_file source",
          rejectSymlinkAncestors: true,
        })
        if (existsSync(sourceComposePath)) {
          out(`🐳 Would configure Docker Compose: ${config.docker_compose_file}`)
        } else {
          out(`⚠️  Docker Compose source not found: ${config.docker_compose_file} (would skip)`)
        }
      } else if (portReservationFailed) {
        composeFailed = true
        out("⏭️  Skipping Docker Compose setup because sibling port reservations are incomplete")
      } else {
        const composeResult = await setupDockerCompose(
          gitRoot,
          worktreePath,
          config,
          branch,
          envChanges,
          reservedPorts,
          setupIssues
        )
        composePorts = composeResult.portChanges
        composeIdentity = composeResult.identity
        composeValueChanges = composeResult.composeValueChanges
        composeFailed = composeResult.failed
      }
    }

    // The repository-wide allocation/write transaction is now complete: the lock covers
    // worktree creation, copy/link, env allocation, and Compose allocation + atomic write.
    // Volume cloning and start commands can be slow and have their own safety protocols, so
    // release before either phase to avoid blocking unrelated repository operations.
    if (releaseRepositoryLock) {
      await releaseRepositoryLock()
      releaseRepositoryLock = undefined
    }

    // Data phase: either SEED (run a seed command, never touching the source volume)
    // or CLONE (auto-copy named compose volumes so e.g. PostgreSQL data carries over).
    // --seed replaces cloning entirely, so the source stack is never stopped.
    let volumeFailures = 0
    if (
      config.docker_compose_file &&
      !skipDocker &&
      !dryRun &&
      !composeFailed &&
      setupIssues.failures.length === 0
    ) {
      volumeResult = preflightTargetComposeVolumes(
        gitRoot,
        worktreePath,
        config,
        branch,
        repository.commonGitDir
      )
      volumeFailures = volumeResult.failed.length
      for (const failure of volumeResult.failed) {
        out(`  ❌ Target volume safety check failed (${failure.name}): ${failure.error}`)
      }
    }
    let seedFailed = false
    let seedRan = false
    const acquireLifecycleVolumes = async (requireEmpty: boolean): Promise<void> => {
      let releaseLifecycleRepositoryLock: Awaited<
        ReturnType<typeof acquireRepositoryLock>
      > | undefined
      try {
        // Atomic overwrite publishes recovery state under this same lock. Re-read
        // it while serialized, then retain Docker leases after releasing the
        // short repository critical section.
        releaseLifecycleRepositoryLock = await acquireRepositoryLock(repository)
        const safety = preflightTargetComposeVolumes(
          gitRoot,
          worktreePath,
          config,
          branch,
          repository.commonGitDir
        )
        if (safety.failed.length > 0) {
          throw new Error(safety.failed.map(({ name, error }) => `${name}: ${error}`).join("; "))
        }
        targetLifecycleLease = acquireWorktreeTargetVolumeLifecycleLeases(
          gitRoot,
          worktreePath,
          config,
          branch,
          requireEmpty
        )
      } catch (error) {
        const message = `Could not safely prepare target volumes for lifecycle commands: ${getErrorMessage(error)}`
        volumeResult.failed.push({ name: config.docker_compose_file, error: message })
        volumeFailures = volumeResult.failed.length
        out(`  ❌ ${message}`)
      } finally {
        if (releaseLifecycleRepositoryLock) await releaseLifecycleRepositoryLock()
      }
    }
    if (useSeed) {
      // seedCommand is guaranteed non-empty here (validated above).
      out("")
      if (dryRun) {
        out(`🌱 Would seed data instead of cloning volumes: ${seedCommand}`)
      } else if (
        composeFailed ||
        setupIssues.failures.length > 0 ||
        volumeFailures > 0
      ) {
        out(
          "⏭️  Skipping seed command because setup failed; running it against an unisolated or incomplete worktree could modify source data"
        )
      } else {
        await acquireLifecycleVolumes(true)
        if (volumeFailures > 0) {
          out(
            "⏭️  Skipping seed command because target volumes could not be prepared as fresh, exclusively-owned volumes"
          )
        } else {
        out(`🌱 Seeding data instead of cloning volumes: ${seedCommand}`)
        seedRan = true
        seedFailed = !(await executeSeedCommand(seedCommand as string, worktreePath))
        }
      }
    } else if (config.docker_compose_file && !skipDocker) {
      out("")
      if (composeFailed) {
        out("⏭️  Skipping volume clone because Docker Compose setup failed")
      } else if (volumeFailures > 0) {
        out("⏭️  Skipping volume clone because target volume ownership validation failed")
      } else if (skipVolumeCopy) {
        out("⏭️  Skipping volume clone (--no-volume-copy)")
      } else if (dryRun) {
        previewVolumeCopy(gitRoot, config)
      } else {
        volumeResult = await setupVolumeCopy(gitRoot, worktreePath, config, {
          force: forceVolumeCopy,
          stop: options.stop,
          branch,
          commonGitDir: repository.commonGitDir,
        })
        volumeFailures = volumeResult.failed.length
      }
    }

    // Clone may only cover a configured subset. Prepare and pin every remaining
    // non-external target volume as well, then keep the leases through
    // start_command so Compose cannot adopt a concurrently substituted volume.
    if (
      !useSeed &&
      config.docker_compose_file &&
      !skipDocker &&
      !dryRun &&
      !composeFailed &&
      setupIssues.failures.length === 0 &&
      volumeFailures === 0
    ) {
      await acquireLifecycleVolumes(false)
    }

    // A stop command may fail after partially stopping services. If recovery also
    // failed, do not start the target stack while the source environment is in an
    // unknown/down state.
    const sourceRestartFailed = volumeResult.sourceStack?.restarted === false

    // start_command phase
    if (config.start_command) {
      out("")
      if (skipStart) {
        out("⏭️  Skipping start command (--no-start)")
      } else if (dryRun) {
        out(`🚀 Would run start command: ${config.start_command}`)
      } else if (
        composeFailed ||
        setupIssues.failures.length > 0 ||
        volumeFailures > 0 ||
        seedFailed ||
        sourceRestartFailed
      ) {
        out(
          "⏭️  Skipping start command because setup/data isolation failed; the command could start an incomplete worktree or operate on the source Compose stack"
        )
      } else {
        out(`🚀 Running start command: ${config.start_command}`)
        startCommandRan = true
        startCommandFailed = !(await executeStartCommand(config.start_command, worktreePath))
        if (startCommandFailed) {
          addSetupIssue(setupIssues, "failure", {
            phase: "start",
            message: "start_command failed",
          })
        }
      }
    }

    if (targetLifecycleLease) {
      try {
        targetLifecycleLease.release()
        targetLifecycleLease = undefined
      } catch (error) {
        const message = `Failed to release target volume lifecycle lease(s): ${getErrorMessage(error)}`
        volumeResult.failed.push({ name: config.docker_compose_file, error: message })
        volumeFailures = volumeResult.failed.length
        out(`  ❌ ${message}`)
      }
    }

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
      } else if (setupIssues.failures.length > 0 || startCommandFailed) {
        out(
          `⚠️  Worktree created, but ${setupIssues.failures.length} setup operation(s) FAILED. The worktree was kept; review the errors above before using it.`
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
      try {
        const worktrees = listWorktrees(gitRoot)
        for (const wt of worktrees) {
          const isNew = wt.branch === branch
          out(`  ${isNew ? "→" : " "} ${wt.branch}: ${wt.path}`)
        }
      } catch (error) {
        // Creation/setup is already complete. A presentation-only refresh must not turn a
        // usable worktree into a reported create failure or suppress the JSON result.
        out(`  ⚠️  Could not list current worktrees: ${getErrorMessage(error)}`)
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
        seed: useSeed ? { ran: seedRan, failed: seedFailed } : null,
        startCommand: config.start_command
          ? { ran: startCommandRan, failed: startCommandFailed }
          : null,
        composeFailed,
        setupWarnings: setupIssues.warnings,
        setupFailures: setupIssues.failures,
        ok:
          volumeFailures === 0 &&
          !seedFailed &&
          !sourceRestartFailed &&
          !composeFailed &&
          !startCommandFailed &&
          setupIssues.failures.length === 0,
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
      (volumeFailures > 0 ||
        seedFailed ||
        composeFailed ||
        startCommandFailed ||
        setupIssues.failures.length > 0)
    ) {
      process.exitCode = EXIT_CODES.GENERAL_ERROR
    }
  } finally {
    if (targetLifecycleLease) {
      try {
        targetLifecycleLease.release()
      } catch {
        // The primary error is more actionable. A retained stopped lease fails
        // safe by keeping its volume pinned for manual inspection.
      }
    }
    if (releaseRepositoryLock) await releaseRepositoryLock()
  }
}

/**
 * --json 用の機械可読な結果オブジェクトを stdout に 1 つだけ書き込む。
 */
function writeJsonResult(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
}

/** Prevent recursive copy trees and self-referential directory symlinks. */
export function assertSetupSourceDoesNotContainWorktree(
  sourceRoot: string,
  worktreePath: string,
  configuredPath: string,
  phase: "copy" | "link"
): void {
  const sourcePath = resolveRepositoryPath(sourceRoot, configuredPath, {
    field: `${phase}_files source`,
    rejectSymlinkAncestors: true,
  })
  if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) return
  const canonicalSource = realpathSync(sourcePath)
  const canonicalWorktree = realpathSync(worktreePath)
  const relative = path.relative(canonicalSource, canonicalWorktree)
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    throw new Error(
      `directory source '${configuredPath}' contains the target worktree; ${phase} would recurse into its own destination`
    )
  }
}

/**
 * Preflight every destination corresponding to a source descendant. fs-extra's
 * recursive copy may otherwise follow an existing destination symlink and
 * overwrite a file outside the worktree.
 */
function assertCopyDestinationsAreNotSymlinks(sourcePath: string, targetPath: string): void {
  const pending = [{ source: sourcePath, target: targetPath }]
  while (pending.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: guarded by pending.length
    const current = pending.pop()!
    try {
      if (lstatSync(current.target).isSymbolicLink()) {
        throw new Error(`copy destination is a symlink: ${current.target}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }

    const sourceStat = lstatSync(current.source)
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) continue
    for (const name of fs.readdirSync(current.source)) {
      pending.push({
        source: path.join(current.source, name),
        target: path.join(current.target, name),
      })
    }
  }
}

/**
 * 設定ファイルで指定されたファイル/ディレクトリをworktreeにコピー
 */
export async function copyConfiguredFiles(
  sourceRoot: string,
  targetRoot: string,
  copyFiles: string[],
  issues: SetupIssues = emptySetupIssues(),
  phase: SetupPhase = "copy"
): Promise<SetupIssues> {
  for (const relativePath of copyFiles) {
    try {
      const sourcePath = resolveRepositoryPath(sourceRoot, relativePath, {
        field: `${phase} source`,
        rejectSymlinkAncestors: true,
      })
      let targetPath = resolveRepositoryPath(targetRoot, relativePath, {
        field: `${phase} target`,
        rejectSymlinkAncestors: true,
      })

      if (!existsSync(sourcePath)) {
        const message = `Source not found: ${relativePath}`
        out(`  ⚠️  Skip (not found): ${relativePath}`)
        addSetupIssue(issues, "warning", { phase, path: relativePath, message })
        continue
      }

      const stat = statSync(sourcePath)
      await fs.ensureDir(path.dirname(targetPath))
      // Re-resolve after creating the parent so a concurrently introduced
      // symlink cannot redirect the copy outside the worktree.
      targetPath = resolveRepositoryPath(targetRoot, relativePath, {
        field: `${phase} target`,
        rejectSymlinkAncestors: true,
      })

      assertCopyDestinationsAreNotSymlinks(sourcePath, targetPath)

      if (stat.isDirectory()) {
        if (phase === "env") {
          throw new Error(`Environment path must be a file: ${relativePath}`)
        }
        await fs.copy(sourcePath, targetPath, { overwrite: true })
        out(`  ✅ Copied directory: ${relativePath}`)
      } else {
        if (phase === "env") copyEnvFileAtomic(sourcePath, targetPath)
        else await fs.copy(sourcePath, targetPath, { overwrite: true })
        out(`  ✅ Copied file: ${relativePath}`)
      }
    } catch (error) {
      const message = getErrorMessage(error)
      out(`  ❌ Failed to copy ${relativePath}: ${message}`)
      addSetupIssue(issues, "failure", { phase, path: relativePath, message })
    }
  }
  return issues
}

/**
 * 設定ファイルで指定されたファイル/ディレクトリをworktreeにシンボリックリンクで張る
 */
export async function linkConfiguredFiles(
  sourceRoot: string,
  targetRoot: string,
  linkFiles: string[],
  issues: SetupIssues = emptySetupIssues()
): Promise<SetupIssues> {
  for (const relativePath of linkFiles) {
    try {
      const sourcePath = resolveRepositoryPath(sourceRoot, relativePath, {
        field: "link source",
        rejectSymlinkAncestors: true,
      })
      let targetPath = resolveRepositoryPath(targetRoot, relativePath, {
        field: "link target",
        rejectSymlinkAncestors: true,
      })

      if (!existsSync(sourcePath)) {
        const message = `Source not found: ${relativePath}`
        out(`  ⚠️  Skip (not found): ${relativePath}`)
        addSetupIssue(issues, "warning", {
          phase: "link",
          path: relativePath,
          message,
        })
        continue
      }

      await fs.ensureDir(path.dirname(targetPath))
      targetPath = resolveRepositoryPath(targetRoot, relativePath, {
        field: "link target",
        rejectSymlinkAncestors: true,
      })

      let targetStat: ReturnType<typeof lstatSync> | undefined
      try {
        targetStat = lstatSync(targetPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }

      let replacementMessage: string | undefined
      if (targetStat?.isSymbolicLink()) {
        const currentLink = readlinkSync(targetPath)
        const resolvedCurrent = path.resolve(path.dirname(targetPath), currentLink)
        if (resolvedCurrent === sourcePath) {
          out(`  ✅ Symlink already correct: ${relativePath}`)
          continue
        }
        replacementMessage = `Replacing symlink (was → ${currentLink})`
      } else if (targetStat?.isDirectory()) {
        replacementMessage = "Replacing existing directory with symlink"
      } else if (targetStat) {
        replacementMessage = "Replacing existing file with symlink"
      }

      const token = `${process.pid}-${randomUUID()}`
      const tempPath = path.join(
        path.dirname(targetPath),
        `.${path.basename(targetPath)}.wtb-link-${token}.tmp`
      )
      const backupPath = path.join(
        path.dirname(targetPath),
        `.${path.basename(targetPath)}.wtb-link-${token}.backup`
      )
      let ownsTemp = false
      let movedExisting = false

      try {
        symlinkSync(sourcePath, tempPath)
        ownsTemp = true
        if (targetStat) {
          renameSync(targetPath, backupPath)
          movedExisting = true
        }
        renameSync(tempPath, targetPath)
        ownsTemp = false
      } catch (replaceError) {
        if (ownsTemp) {
          try {
            await fs.remove(tempPath)
          } catch {
            // Preserve the replacement error.
          }
        }
        if (movedExisting) {
          try {
            renameSync(backupPath, targetPath)
            movedExisting = false
          } catch (restoreError) {
            throw new Error(
              `${getErrorMessage(replaceError)}; failed to restore original target (${getErrorMessage(restoreError)}). Recovery copy remains at ${backupPath}`
            )
          }
        }
        throw replaceError
      }

      if (replacementMessage) out(`  🔄 ${replacementMessage}: ${relativePath}`)
      out(`  ✅ Symlinked: ${relativePath} → ${sourcePath}`)

      if (movedExisting) {
        try {
          await fs.remove(backupPath)
        } catch (error) {
          const message = `Symlink installed, but failed to remove backup ${backupPath}: ${getErrorMessage(error)}`
          out(`  ❌ ${message}`)
          addSetupIssue(issues, "failure", {
            phase: "link",
            path: relativePath,
            message,
          })
        }
      }
    } catch (error) {
      const message = getErrorMessage(error)
      out(`  ❌ Failed to symlink ${relativePath}: ${message}`)
      addSetupIssue(issues, "failure", {
        phase: "link",
        path: relativePath,
        message,
      })
    }
  }
  return issues
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
export async function setupDockerCompose(
  gitRoot: string,
  worktreePath: string,
  config: WtbConfig,
  branch: string,
  envChanges: Record<string, { from: string; to: string }> = {},
  reservedPorts?: Set<number>,
  issues: SetupIssues = emptySetupIssues()
): Promise<SetupComposeResult> {
  const portChanges: ComposePortChanges = {}
  const emptyIdentity: ComposeIdentityRewrite = { containerNames: [] }
  const composeValueChanges: ComposeValueChange[] = []
  if (!config.docker_compose_file) {
    return { portChanges, identity: emptyIdentity, composeValueChanges, failed: false }
  }

  let identity: ComposeIdentityRewrite = emptyIdentity
  let failed = false
  try {
    assertNoTransientComposeProjectOverride(process.env)
    const mainComposePath = resolveRepositoryPath(gitRoot, config.docker_compose_file, {
      field: "docker_compose_file source",
      rejectSymlinkAncestors: true,
    })
    let targetComposePath = resolveRepositoryPath(worktreePath, config.docker_compose_file, {
      field: "docker_compose_file target",
      rejectSymlinkAncestors: true,
    })
    const targetComposeEnvironment = loadComposeInterpolationEnvironment(worktreePath)
    assertNoComposeSourceOverrides(targetComposeEnvironment)
    const automaticComposeFiles = [
      "compose.yaml",
      "compose.yml",
      "docker-compose.yaml",
      "docker-compose.yml",
      "compose.override.yaml",
      "compose.override.yml",
      "docker-compose.override.yaml",
      "docker-compose.override.yml",
    ]
    const configuredTarget = path.resolve(targetComposePath)
    const bypassFiles = automaticComposeFiles
      .map((fileName) => path.join(worktreePath, fileName))
      .filter(
        (candidate) => path.resolve(candidate) !== configuredTarget && existsSync(candidate)
      )
    if (bypassFiles.length > 0) {
      throw new Error(
        `Additional auto-loaded Compose file(s) can bypass the isolated docker_compose_file: ${bypassFiles.map((candidate) => path.relative(worktreePath, candidate)).join(", ")}`
      )
    }

    // A tracked Compose file is already checked out from the requested branch,
    // and therefore wins over main. Gitignored/untracked Compose files are not
    // present in the target, so those fall back to the main worktree's copy.
    const inputComposePath = existsSync(targetComposePath) ? targetComposePath : mainComposePath
    const copiedFromMain = inputComposePath === mainComposePath
    if (!existsSync(inputComposePath)) {
      const message = `Docker Compose source not found: ${config.docker_compose_file}`
      out(`⚠️  ${message} (skipped)`)
      addSetupIssue(issues, "warning", {
        phase: "compose",
        path: config.docker_compose_file,
        message,
      })
      return { portChanges, identity: emptyIdentity, composeValueChanges, failed: false }
    }

    out("🐳 Configuring Docker Compose...")

    // Read the selected branch/main input once, then apply every transform in memory.
    const sourceConfig = readComposeFile(inputComposePath)
    assertComposeStorageDefinitionsSafe(sourceConfig)
    // The main Compose remains the source-stack authority even when a tracked
    // branch Compose is the transformation input. Resolve it once and reuse it
    // for identity and volume-sharing guards.
    const mainConfigForSafety = existsSync(mainComposePath)
      ? copiedFromMain
        ? sourceConfig
        : readComposeFile(mainComposePath)
      : null
    if (mainConfigForSafety) assertComposeStorageDefinitionsSafe(mainConfigForSafety)

    // ── (1) identity 書き換え (per-worktree な project/container 名分離) ────────────
    const composeIdentity = config.compose ?? { isolate_name: true, container_name: "suffix" }
    let workingConfig = sourceConfig
    if (composeIdentity.isolate_name || composeIdentity.container_name !== "keep") {
      // 他 worktree の slug と衝突する場合は raw branch のハッシュで一意化する
      // (unicode/記号だけ違う別ブランチが同一 project slug に畳まれる事故を防ぐ)。
      const otherBranches = safeWorktreeBranches(gitRoot)
      const slug = uniqueProjectSlug(branch, otherBranches)
      const selectedName = (sourceConfig as { name?: unknown }).name
      const selectedHasExplicitName =
        typeof selectedName === "string" && selectedName.length > 0
      const identityBaseConfig = selectedHasExplicitName
        ? sourceConfig
        : (mainConfigForSafety ?? sourceConfig)
      const identityBaseComposePath = selectedHasExplicitName
        ? inputComposePath
        : mainConfigForSafety
          ? mainComposePath
          : inputComposePath
      const identityBaseWorkdir = selectedHasExplicitName
        ? copiedFromMain
          ? gitRoot
          : worktreePath
        : mainConfigForSafety
          ? gitRoot
          : worktreePath
      const baseProjectName = composeIdentity.isolate_name
        ? resolveComposeProjectNameForWorktree(
            identityBaseConfig,
            identityBaseWorkdir,
            process.env,
            path.dirname(identityBaseComposePath)
          )
        : undefined
      const rewritten = rewriteComposeIdentity(workingConfig, {
        slug,
        isolateName: composeIdentity.isolate_name,
        containerNameMode: composeIdentity.container_name,
        baseProjectName,
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
    const allocationReservations =
      reservedPorts ??
      new Set<number>([
        ...collectWorktreeEnvPorts(worktreePath, config),
        ...collectWorktreeComposePorts(worktreePath, config),
      ])
    if (!reservedPorts) {
      for (const p of getUsedPortsOrThrow()) allocationReservations.add(p)
    }
    for (const change of Object.values(envChanges)) {
      const p = Number.parseInt(change.to, 10)
      if (!Number.isNaN(p)) allocationReservations.add(p)
    }

    const isolatedPublishedVariables = new Set(
      Object.entries(envChanges)
        .filter(
          ([name, change]) =>
            typeof config.env.adjust[name] === "number" &&
            /^\d+$/.test(change.to) &&
            targetComposeEnvironment[name] === change.to
        )
        .map(([name]) => name)
    )
    let adjustedConfig = adjustPortsInCompose(
      workingConfig,
      [...allocationReservations],
      isolatedPublishedVariables
    )

    // `name:` is only one source of Compose identity. The shell and each
    // worktree's `.env` can set COMPOSE_PROJECT_NAME, and an interpolated name
    // can resolve differently from its raw YAML scalar. Compare the identities
    // Docker will actually use before writing or running any lifecycle command.
    let volumeLabelsChanged = false
    const targetProject = resolveComposeProjectNameForWorktree(
      adjustedConfig,
      worktreePath,
      process.env,
      path.dirname(targetComposePath)
    )
    if (mainConfigForSafety) {
      const sourceProject = resolveComposeProjectNameForWorktree(
        mainConfigForSafety,
        gitRoot,
        process.env,
        path.dirname(mainComposePath)
      )
      if (sourceProject === targetProject) {
        throw new Error(
          `Source and target resolve to the same Compose project ('${targetProject}'); unset COMPOSE_PROJECT_NAME or make the project identity worktree-specific`
        )
      }

      assertNoSharedComposeVolumes(
        mainConfigForSafety,
        adjustedConfig,
        sourceProject,
        targetProject
      )
    }
    assertComposeProjectUnique(
      listWorktrees(gitRoot),
      worktreePath,
      config.docker_compose_file,
      targetProject
    )
    assertDockerComposeProjectOwnedByWorktree(
      targetProject,
      worktreePath,
      config.docker_compose_file
    )
    const labeled = applyComposeVolumeOwnershipLabels(adjustedConfig, {
      repo: repoVolumeLabel(gitRoot),
      project: targetProject,
      branch,
    })
    adjustedConfig = labeled.config
    volumeLabelsChanged = labeled.changed

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
        const originalHostPort = fixedPublishedPort(original)
        const adjustedHostPort = fixedPublishedPort(adjusted)
        if (originalHostPort === null || adjustedHostPort === null) continue
        allocationReservations.add(adjustedHostPort)
        if (originalHostPort === adjustedHostPort) continue
        if (!portChanges[serviceName]) {
          portChanges[serviceName] = []
        }
        portChanges[serviceName].push({
          from: originalHostPort,
          to: adjustedHostPort,
        })
      }
    }

    // M2: identity 書き換え・伝播・ポート調整のいずれも変化を生まなかった場合は、
    // 追跡ファイルを無意味に reformat / skip-worktree しない (checkout 済みのまま残す)。
    const changed =
      identity.projectName !== undefined ||
      identity.containerNames.length > 0 ||
      composeValueChanges.length > 0 ||
      Object.keys(portChanges).length > 0 ||
      volumeLabelsChanged ||
      copiedFromMain

    if (changed) {
      // ── 単一 write: 全 transform を適用し終えた最終形を 1 度だけ書き出す ──────────
      await fs.ensureDir(path.dirname(targetComposePath))
      targetComposePath = resolveRepositoryPath(worktreePath, config.docker_compose_file, {
        field: "docker_compose_file target",
        rejectSymlinkAncestors: true,
      })
      writeComposeFile(targetComposePath, adjustedConfig)
      // compose が git 追跡ファイルの場合、worktree ごとの書き換えで dirty にならないよう
      // skip-worktree を立て、wtb の出力 sha を manifest に記録する (remove の dirty
      // チェック / git status 汚染 / 誤コミット防止 + ユーザー手編集の保護)。
      if (markWtbManagedFile(worktreePath, config.docker_compose_file) === false) {
        throw new Error(
          `Failed to persist managed-file metadata for ${config.docker_compose_file}`
        )
      }
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
    const message = getErrorMessage(error)
    addSetupIssue(issues, "failure", {
      phase: "compose",
      path: config.docker_compose_file,
      message,
    })
    out(
      `  ⚠️  Docker Compose setup FAILED (${message}) — this worktree's compose is NOT isolated; a 'docker compose up' may collide with the source stack.`
    )
  }
  return { portChanges, identity, composeValueChanges, failed }
}

function isExternalComposeVolume(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
  const external = (entry as { external?: unknown }).external
  return external === true || (external !== null && typeof external === "object")
}

/**
 * Non-external volumes must never resolve to a source volume name. A fixed
 * `name:` is an implicit shared-data mount even when project names differ;
 * intentional sharing must be declared `external` so wtb/down -v can preserve it.
 */
function assertNoSharedComposeVolumes(
  sourceConfig: ComposeConfig,
  targetConfig: ComposeConfig,
  sourceProject: string,
  targetProject: string
): void {
  const sourceNames = new Set<string>()
  for (const key of Object.keys(sourceConfig.volumes ?? {})) {
    const resolved = resolveVolumeName(sourceConfig, key, sourceProject)
    if (!resolved || resolved.external) continue
    if (resolved.name.includes("$")) {
      throw new Error(
        `Source volume '${key}' has an interpolated name that wtb cannot prove is isolated: ${resolved.name}`
      )
    }
    sourceNames.add(resolved.name)
  }

  for (const key of Object.keys(targetConfig.volumes ?? {})) {
    const resolved = resolveVolumeName(targetConfig, key, targetProject)
    if (!resolved || resolved.external) continue
    if (resolved.name.includes("$")) {
      throw new Error(
        `Target volume '${key}' has an interpolated name that wtb cannot prove is isolated: ${resolved.name}`
      )
    }
    if (sourceNames.has(resolved.name)) {
      throw new Error(
        `Non-external volume '${key}' resolves to source volume '${resolved.name}'. Mark an intentionally shared volume external, or remove its fixed name so each worktree gets an isolated volume`
      )
    }
  }
}

/** Add durable ownership labels to volumes that Compose may create for the target. */
function applyComposeVolumeOwnershipLabels(
  config: ComposeConfig,
  ownership: VolumeOwnership
): { config: ComposeConfig; changed: boolean } {
  const next = structuredClone(config) as ComposeConfig
  if (!next.volumes) return { config: next, changed: false }

  const ownershipLabels: Record<string, string> = {
    [WTB_VOLUME_LABELS.managed]: "true",
    [WTB_VOLUME_LABELS.repo]: ownership.repo,
    [WTB_VOLUME_LABELS.project]: ownership.project,
    [WTB_VOLUME_LABELS.branch]: ownership.branch,
    [WTB_VOLUME_LABELS.temp]: "false",
  }
  const reserved = new Set(Object.keys(ownershipLabels))
  let changed = false

  for (const key of Object.keys(next.volumes)) {
    const original = next.volumes[key]
    if (isExternalComposeVolume(original)) continue
    if (original != null && (typeof original !== "object" || Array.isArray(original))) {
      throw new Error(`Compose volume '${key}' has an unsupported definition`)
    }

    const entry = original == null ? {} : { ...(original as Record<string, unknown>) }
    const existingLabels = entry.labels
    if (Array.isArray(existingLabels)) {
      const kept = existingLabels.filter((label) => {
        if (typeof label !== "string") return true
        return !reserved.has(label.split("=", 1)[0])
      })
      entry.labels = [
        ...kept,
        ...Object.entries(ownershipLabels).map(([label, value]) => `${label}=${value}`),
      ]
    } else if (
      existingLabels === undefined ||
      existingLabels === null ||
      (typeof existingLabels === "object" && !Array.isArray(existingLabels))
    ) {
      entry.labels = {
        ...((existingLabels ?? {}) as Record<string, unknown>),
        ...ownershipLabels,
      }
    } else {
      throw new Error(`Compose volume '${key}' has unsupported labels`)
    }

    if (JSON.stringify(original) !== JSON.stringify(entry)) changed = true
    next.volumes[key] = entry
  }
  return { config: next, changed }
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

/** Resolve, create if needed, and pin every target-side non-external volume. */
function acquireWorktreeTargetVolumeLifecycleLeases(
  gitRoot: string,
  worktreePath: string,
  config: WtbConfig,
  branch: string,
  requireEmpty: boolean
): TargetVolumeLifecycleLease {
  if (!config.docker_compose_file) {
    return { release: () => undefined }
  }
  const composePath = resolveRepositoryPath(worktreePath, config.docker_compose_file, {
    field: "docker_compose_file target",
    rejectSymlinkAncestors: true,
  })
  if (!existsSync(composePath)) {
    throw new Error(`Target Compose file is missing: ${config.docker_compose_file}`)
  }
  const composeConfig = readComposeFile(composePath)
  assertComposeStorageDefinitionsSafe(composeConfig)
  const targetProject = resolveComposeProjectNameForWorktree(
    composeConfig,
    worktreePath,
    process.env,
    path.dirname(composePath)
  )
  assertComposeProjectUnique(
    listWorktrees(gitRoot),
    worktreePath,
    config.docker_compose_file,
    targetProject
  )
  assertDockerComposeProjectOwnedByWorktree(
    targetProject,
    worktreePath,
    config.docker_compose_file
  )
  const targetVolumes: string[] = []
  for (const key of Object.keys(composeConfig.volumes ?? {})) {
    const resolved = resolveVolumeName(composeConfig, key, targetProject)
    if (resolved && !resolved.external) targetVolumes.push(resolved.name)
  }
  return acquireTargetVolumeLifecycleLeases(
    targetVolumes,
    {
      repo: repoVolumeLabel(gitRoot),
      project: targetProject,
      branch,
    },
    { requireEmpty }
  )
}

/**
 * Validate every target-side non-external volume before any seed/clone/start
 * path. This is deliberately independent of the source clone list: branch-only
 * and excluded volumes, `--seed`, and `--no-volume-copy` must not be allowed to
 * adopt a pre-existing foreign or unmanaged data volume.
 */
export function preflightTargetComposeVolumes(
  gitRoot: string,
  worktreePath: string,
  config: WtbConfig,
  branch: string,
  commonGitDir: string
): VolumeCopyResult {
  const result = emptyVolumeCopyResult()
  if (!config.docker_compose_file) return result

  let composeConfig: ComposeConfig
  let targetProject: string
  try {
    const composePath = resolveRepositoryPath(worktreePath, config.docker_compose_file, {
      field: "docker_compose_file target",
      rejectSymlinkAncestors: true,
    })
    if (!existsSync(composePath)) {
      throw new Error(`Target Compose file is missing: ${config.docker_compose_file}`)
    }
    composeConfig = readComposeFile(composePath)
    assertComposeStorageDefinitionsSafe(composeConfig)
    targetProject = resolveComposeProjectNameForWorktree(
      composeConfig,
      worktreePath,
      process.env,
      path.dirname(composePath)
    )
    assertComposeProjectUnique(
      listWorktrees(gitRoot),
      worktreePath,
      config.docker_compose_file,
      targetProject
    )
    assertDockerComposeProjectOwnedByWorktree(
      targetProject,
      worktreePath,
      config.docker_compose_file
    )
  } catch (error) {
    result.failed.push({
      name: config.docker_compose_file,
      error: `Could not inspect target Compose volumes: ${getErrorMessage(error)}`,
    })
    return result
  }

  const ownership: VolumeOwnership = {
    repo: repoVolumeLabel(gitRoot),
    project: targetProject,
    branch,
  }
  let recoveryTargets: Set<string>
  try {
    recoveryTargets = new Set(
      readVolumeRecoveryRecords(getVolumeRecoveryDirectory(commonGitDir)).map(
        ({ record }) => record.targetVolume
      )
    )
  } catch (error) {
    result.failed.push({
      name: config.docker_compose_file,
      error: `Could not verify volume recovery state: ${getErrorMessage(error)}`,
    })
    return result
  }
  for (const key of Object.keys(composeConfig.volumes ?? {})) {
    const target = resolveVolumeName(composeConfig, key, targetProject)
    if (!target || target.external) continue
    if (recoveryTargets.has(target.name)) {
      result.failed.push({
        name: key,
        error: `Target volume '${target.name}' has an unresolved recovery record; recover or explicitly discard it before reusing this target`,
      })
      continue
    }
    try {
      preflightTargetVolumeForCopy(target.name, ownership)
    } catch (error) {
      result.failed.push({ name: key, error: getErrorMessage(error) })
    }
  }
  return result
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
  options: { force?: boolean; stop?: boolean; branch: string; commonGitDir: string }
): Promise<VolumeCopyResult> {
  if (!config.docker_compose_file) return emptyVolumeCopyResult()

  try {
    assertNoTransientComposeProjectOverride(process.env)
  } catch (error) {
    const result = emptyVolumeCopyResult()
    result.failed.push({ name: config.docker_compose_file, error: getErrorMessage(error) })
    return result
  }

  const targetSafety = preflightTargetComposeVolumes(
    gitRoot,
    worktreePath,
    config,
    options.branch,
    options.commonGitDir
  )
  if (targetSafety.failed.length > 0) {
    for (const failure of targetSafety.failed) {
      out(`📦 Volume clone failed (${failure.name}): ${failure.error}`)
    }
    return targetSafety
  }

  const sourceComposePath = resolveRepositoryPath(gitRoot, config.docker_compose_file, {
    field: "docker_compose_file source",
    rejectSymlinkAncestors: true,
  })
  if (!existsSync(sourceComposePath)) return emptyVolumeCopyResult()

  // source の compose を読む。target project / target volume の解決には worktree の
  // identity-rewrite 済みコピーを使う (compose phase が volume phase より前に走るので
  // 既に存在する)。読めなければ source config にフォールバック。
  let composeConfig: ReturnType<typeof readComposeFile>
  try {
    composeConfig = readComposeFile(sourceComposePath)
  } catch (error) {
    const message = `Cannot read source Compose file: ${getErrorMessage(error)}`
    out(`📦 Volume clone failed: ${message}`)
    const result = emptyVolumeCopyResult()
    result.failed.push({ name: config.docker_compose_file, error: message })
    return result
  }

  const exclude = config.volumes?.exclude ?? []
  const cloneable = discoverCloneableVolumes(composeConfig, exclude)
  if (cloneable.length === 0) {
    return emptyVolumeCopyResult() // nothing to copy — silent
  }

  // Compose の実際のプロジェクト名 (compose-spec 準拠) を解決する。
  // source は source config + gitRoot、target は worktree の identity-rewrite 済み
  // コピー + worktreePath から解決する (project 名が分離されているので別物になる)。
  const sourceProject = resolveComposeProjectNameForWorktree(
    composeConfig,
    gitRoot,
    process.env,
    path.dirname(sourceComposePath)
  )
  try {
    assertDockerComposeProjectOwnedByWorktree(
      sourceProject,
      gitRoot,
      config.docker_compose_file
    )
  } catch (error) {
    const message = `Cannot prove ownership of the source Compose project: ${getErrorMessage(error)}`
    const result = emptyVolumeCopyResult()
    for (const key of cloneable) result.failed.push({ name: key, error: message })
    return result
  }
  const targetComposePath = resolveRepositoryPath(worktreePath, config.docker_compose_file, {
    field: "docker_compose_file target",
    rejectSymlinkAncestors: true,
  })
  let targetComposeConfig = composeConfig
  try {
    if (existsSync(targetComposePath)) {
      targetComposeConfig = readComposeFile(targetComposePath)
    }
  } catch (error) {
    // An existing target Compose is authoritative. Falling back after a parse/read
    // failure could resolve different target volume names and write data where the
    // checked-out branch will never use it.
    const message = `Cannot read target Compose file: ${getErrorMessage(error)}`
    out(`📦 Volume clone failed: ${message}`)
    const result = emptyVolumeCopyResult()
    for (const key of cloneable) result.failed.push({ name: key, error: message })
    return result
  }
  const targetProject = resolveComposeProjectNameForWorktree(
    targetComposeConfig,
    worktreePath,
    process.env,
    path.dirname(targetComposePath)
  )
  const ownership = {
    repo: repoVolumeLabel(gitRoot),
    project: targetProject,
    branch: options.branch,
  }
  const recoveryDirectory = getVolumeRecoveryDirectory(options.commonGitDir)
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

  let cloneOperationLock: ReturnType<typeof acquireVolumeCloneOperationLock>
  try {
    cloneOperationLock = acquireVolumeCloneOperationLock(ownership.repo, sourceProject)
  } catch (error) {
    const message = `Could not acquire the source clone-operation lock: ${getErrorMessage(error)}`
    out(`  ❌ ${message}`)
    for (const key of cloneable) result.failed.push({ name: key, error: message })
    return result
  }

  try {
  // ── plan-before-stop: stop する前に全 cloneable volume を分類する ──────────────
  const stopEnabled = options.stop !== false
  const force = options.force === true
  let plan: VolumeClonePlanEntry[]
  try {
    plan = planVolumeClones(
      cloneable,
      composeConfig,
      targetComposeConfig,
      sourceProject,
      targetProject,
      { force, stopEnabled, ownership }
    )
  } catch (error) {
    const message = `Could not safely inspect Docker volumes: ${getErrorMessage(error)}`
    out(`  ❌ ${message}`)
    for (const key of cloneable) result.failed.push({ name: key, error: message })
    return result
  }

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
  let stopAttempted = false
  let stoppedStack = false
  let stopError: string | undefined

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

    // `docker compose stop` can time out or fail after stopping only some services. Treat
    // the stack as recovery-required from the moment the stop attempt begins, and install
    // the abort handler before invoking Docker so a signal during the command cannot leave
    // the source environment partially stopped.
    stopAttempted = true
    restartOnAbort = () => {
      out("")
      out("  ⚠️  Interrupted — restoring the source Compose stack before exit...")
      const r = restartSourceStack()
      if (r.restarted) {
        out("  ✅ Source stack restored")
      } else {
        out(`  ⚠️  Failed to restore source stack: ${r.error}`)
        out(`     Your source environment may be DOWN. Bring it back up manually: ${recoverCommand}`)
      }
    }
    for (const sig of abortSignals) {
      process.prependListener(sig, restartOnAbort)
    }

    try {
      composeStop(sourceComposePath, sourceProject, gitRoot)
      stoppedStack = true
    } catch (error) {
      stopError = getErrorMessage(error)
      out(
        `  ❌ Could not safely stop source stack (${stopError}) — it may be partially stopped; clone-after-stop volumes failed and recovery will be attempted`
      )
      // A failed stop is not an intentional skip: data isolation was not completed. Keep
      // the entries out of the copy loop, but surface every affected volume as a failure so
      // create/reclone JSON gets ok:false (and --strict exits non-zero).
      for (const entry of plan) {
        if (entry.action === "clone-after-stop") {
          entry.action = "skip"
          entry.reason = `could not safely stop source stack: ${stopError}`
          result.failed.push({ name: entry.key, error: entry.reason })
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
        let usingContainers: string[]
        try {
          usingContainers = getContainersUsingVolumeOrThrow(source.name)
        } catch (error) {
          const message = `could not verify source volume usage after stopping: ${getErrorMessage(error)}`
          out(`  ❌ ${entry.key}: ${message}`)
          result.failed.push({ name: entry.key, error: message })
          continue
        }
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

      let targetHadData = false
      let targetPreflight: ReturnType<typeof preflightTargetVolumeForCopy>
      try {
        targetPreflight = preflightTargetVolumeForCopy(target.name, ownership)
      } catch (error) {
        const message = `target volume changed after planning: ${getErrorMessage(error)}`
        out(`  ❌ ${entry.key}: ${message}`)
        result.failed.push({ name: entry.key, error: message })
        continue
      }
      if (targetPreflight.size > 0) {
        // The strict preflight above proved exact ownership. Existing owned data is
        // an intentional skip without force; foreign/unmanaged/unknown state is a
        // failure and can never reach this branch.
        if (!force) {
          out(
            `  ⏭️  ${entry.key}: owned target volume '${target.name}' gained data after planning — skipping (use --force-volume-copy to overwrite)`
          )
          result.skipped.push({
            name: entry.key,
            reason: "owned target volume already has data (appeared after planning)",
          })
          continue
        }
        targetHadData = true
      }

      try {
        await copyVolume(source.name, target.name, {
          onProgress: createVolumeCopyProgressHandler(`  📦 ${entry.key}`),
          clearTarget: targetHadData,
          ownership,
          recoveryDirectory,
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
    if (stopAttempted) {
      out("  ▶️  Restoring source Compose stack...")
      const restart = restartSourceStack()
      if (restart.restarted) {
        out(stoppedStack ? "  ✅ Source stack restarted" : "  ✅ Source stack restored")
        result.sourceStack = {
          stopped: stoppedStack,
          restarted: true,
          ...(stopError ? { stopError } : {}),
        }
      } else {
        out(`  ⚠️  Failed to restore source stack: ${restart.error}`)
        out(`     Bring it back up manually: ${recoverCommand}`)
        result.sourceStack = {
          stopped: stoppedStack,
          restarted: false,
          ...(stopError ? { stopError } : {}),
          restartError: restart.error,
          recoverCommand,
        }
      }
    }
  }

  } finally {
    if (result.sourceStack?.restarted === false) {
      const message =
        `Source clone-operation lock '${cloneOperationLock.containerName}' was intentionally retained because the source stack did not recover. ` +
        `Restore the source stack first, then remove that lock container manually.`
      out(`  ⚠️  ${message}`)
      result.failed.push({ name: sourceProject, error: message })
    } else {
      try {
        cloneOperationLock.release()
      } catch (error) {
        const message = `Failed to release source clone-operation lock: ${getErrorMessage(error)}`
        out(`  ❌ ${message}`)
        result.failed.push({ name: sourceProject, error: message })
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
 * 1. source.name === target.name (非 external の固定共有名) → hard failure
 * 2. source volume 不在 → skip
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
  opts: { force: boolean; stopEnabled: boolean; ownership: VolumeOwnership }
): VolumeClonePlanEntry[] {
  const plan: VolumeClonePlanEntry[] = []
  const resolved: Array<{
    key: string
    source: ResolvedVolume
    target: ResolvedVolume
  }> = []

  for (const key of cloneable) {
    const source = resolveVolumeName(composeConfig, key, sourceProject)
    const target = resolveVolumeName(targetComposeConfig, key, targetProject)
    if (!source || !target) continue // external は discover で弾かれている想定
    if (source.external || target.external) continue

    // 1. A non-external fixed name is not an intentional sharing declaration.
    // Treating it as a successful skip lets target services mount and mutate the
    // source database directly. Users who really want sharing must mark it external.
    if (source.name === target.name) {
      throw new Error(
        `Non-external volume '${key}' has the same source and target name ('${source.name}'). Mark it external to share intentionally, or remove the fixed name`
      )
    }

    resolved.push({ key, source, target })
  }

  // Validate *all* targets before consulting any source. Otherwise a first-time source (which is
  // a normal skip) could leave a foreign/unmanaged data volume at a later target name, and the
  // start_command would mount it despite isolation never being established. Empty unmanaged
  // targets are removed here only after strict size/usage checks. copyVolume re-runs the same
  // checks immediately before I/O as the TOCTOU guard.
  const inspected = resolved.map((entry) => ({
    ...entry,
    targetPreflight: preflightTargetVolumeForCopy(entry.target.name, opts.ownership),
  }))

  for (const { key, source, target, targetPreflight } of inspected) {

    // 2. source 不在
    if (!volumeExistsOrThrow(source.name)) {
      plan.push({
        key,
        action: "skip",
        reason: "source volume does not exist yet",
        source,
        target,
      })
      continue
    }

    // 3. target にデータあり AND !force → skip
    if (!opts.force && targetPreflight.size > 0) {
      plan.push({
        key,
        action: "skip",
        reason: "target volume already has data",
        source,
        target,
      })
      continue
    }

    // 4. 稼働中コンテナ (project 付き)
    const holders = getContainersUsingVolumeWithProjectOrThrow(source.name)
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

/** Other worktree branches used to prevent Compose project-slug collisions. */
function safeWorktreeBranches(gitRoot: string): string[] {
  // Failing open as an empty set can assign the same Compose project to two branches.
  // setupDockerCompose's outer guard converts enumeration errors into setupFailures.
  const worktrees = listWorktrees(gitRoot)
  if (worktrees.length === 0) {
    throw new Error("Could not enumerate Git worktrees while assigning a Compose project")
  }
  return worktrees
    .map((w) => w.branch)
    .filter((b): b is string => typeof b === "string" && b.length > 0)
}

/** Return one fixed published host port from short or long Compose syntax. */
function fixedPublishedPort(entry: unknown): number | null {
  if (typeof entry === "string") {
    return parsePortMapping(entry)?.hostPort ?? null
  }
  if (!entry || typeof entry !== "object" || !("published" in entry)) return null
  const published = (entry as { published?: unknown }).published
  const value =
    typeof published === "number"
      ? published
      : typeof published === "string" && /^\d+$/.test(published)
        ? Number.parseInt(published, 10)
        : Number.NaN
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null
}

/** Include every fixed host port declared by a single mapping, including ranges. */
function declaredPublishedPorts(entry: unknown): number[] {
  const fixed = fixedPublishedPort(entry)
  if (fixed !== null) return [fixed]

  let range: string | undefined
  if (typeof entry === "string") {
    const withoutProtocol = entry.replace(/\/[A-Za-z][A-Za-z0-9]*$/, "")
    const segments = withoutProtocol.split(":")
    range = segments.length >= 2 ? segments.at(-2) : undefined
  } else if (entry && typeof entry === "object" && "published" in entry) {
    const published = (entry as { published?: unknown }).published
    if (typeof published === "string") range = published
  }

  const match = range?.match(/^(\d+)-(\d+)$/)
  if (!match) return []
  const start = Number.parseInt(match[1], 10)
  const end = Number.parseInt(match[2], 10)
  if (start < 1 || end > 65535 || end < start) return []
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}

/**
 * 既存の各 worktree (main/source を含む) の compose ファイルから、既に割り当て済みの
 * host ポートを収集する。停止中の兄弟 worktree は docker ps に出ないが同じ host ポートを
 * 予約しているので、compose ファイルを直接読んで衝突回避の母集団に加える。target worktree
 * は自分がこれから書き込むので除外する。
 */
function collectWorktreeComposePorts(targetRoot: string, config: WtbConfig): number[] {
  if (!config.docker_compose_file) return []
  const ports = new Set<number>()
  const resolvedTarget = path.resolve(targetRoot)
  const worktrees = listWorktrees(targetRoot)
  if (worktrees.length === 0) {
    throw new Error("Could not enumerate Git worktrees while reserving Compose ports")
  }
  for (const wt of worktrees) {
    if (path.resolve(wt.path) === resolvedTarget) continue
    const composePath = resolveRepositoryPath(wt.path, config.docker_compose_file, {
      field: "sibling docker_compose_file",
      rejectSymlinkAncestors: true,
    })
    if (!existsSync(composePath)) continue
    const cfg = readComposeFile(composePath)
    assertComposeNetworkingSafe(cfg)
    const interpolationEnvironment = loadComposeInterpolationEnvironment(wt.path)
    for (const [serviceName, svc] of Object.entries(cfg.services ?? {})) {
      if (!Array.isArray(svc.ports)) continue
      for (const [index, entry] of svc.ports.entries()) {
        let resolvedEntry: unknown = entry
        if (typeof entry === "string") {
          const interpolated = interpolateComposeValue(entry, interpolationEnvironment)
          if (interpolated.unresolved.length > 0 || interpolated.value.includes("$")) {
            throw new Error(
              `Sibling Compose ${composePath} service '${serviceName}' ports[${index}] has an unresolved published-port expression: ${entry}`
            )
          }
          resolvedEntry = interpolated.value
        } else if (entry && typeof entry === "object" && "published" in entry) {
          const published = (entry as { published?: unknown }).published
          if (typeof published === "string") {
            const interpolated = interpolateComposeValue(published, interpolationEnvironment)
            if (interpolated.unresolved.length > 0 || interpolated.value.includes("$")) {
              throw new Error(
                `Sibling Compose ${composePath} service '${serviceName}' ports[${index}] has an unresolved long-form published port: ${published}`
              )
            }
            resolvedEntry = { ...entry, published: interpolated.value }
          }
        }
        for (const port of declaredPublishedPorts(resolvedEntry)) ports.add(port)
      }
    }
  }
  return [...ports]
}

/**
 * 既存の各 worktree (main/source を含む) の環境変数ファイルから、既に使われている
 * 有効な TCP ポートに見える全ての数値を収集する。調整対象キーだけを見ると、同じ
 * ファイルの固定ポートへ別キーの bump が衝突するため、キー名に関係なく予約する。
 *
 * source(main) も必ず含めること: main の起動中サービスは自分のポートを占有している
 * ため、新 worktree がそれらと**別キー間で**衝突しないよう避ける必要がある。例えば
 * source が APP_PORT=3000 / DB_PORT=3001 のように隣接ポートを使う場合、source を除外
 * すると新 worktree の APP が 3001 に bump して source の DB と衝突する。target だけ
 * を除外する (まだポート未確定 / これから書き込むため)。
 */
function collectWorktreeEnvPorts(targetRoot: string, config: WtbConfig): number[] {
  if (config.env.file.length === 0) return []

  const usedPorts = new Set<number>()
  const resolvedTarget = path.resolve(targetRoot)

  const worktrees = listWorktrees(targetRoot)
  if (worktrees.length === 0) {
    throw new Error("Could not enumerate Git worktrees while reserving environment ports")
  }
  for (const worktree of worktrees) {
    const resolvedPath = path.resolve(worktree.path)
    // target だけ除外 (これから書き込むため)。source(main) を含む他の全 worktree の
    // ポートは衝突回避の対象。
    if (resolvedPath === resolvedTarget) continue

    for (const relativePath of config.env.file) {
      const envPath = resolveRepositoryPath(worktree.path, relativePath, {
        field: "sibling env.file",
        rejectSymlinkAncestors: true,
      })
      // Missing optional env files retain their historical warning/skip
      // semantics. An existing-but-unreadable file is a fail-closed error.
      if (!existsSync(envPath)) continue
      const parsed = parseEnvFile(envPath)
      for (const entry of parsed.entries) {
        const value = entry.value.trim()
        if (!/^\d+$/.test(value)) continue
        const port = Number.parseInt(value, 10)
        if (port >= 1 && port <= 65535) {
          usedPorts.add(port)
        }
      }
    }
  }

  return [...usedPorts]
}

/** Literal numeric string replacements are fixed assignments, not allocators. */
function configuredFixedEnvPorts(config: WtbConfig): number[] {
  const ports = new Set<number>()
  for (const adjustment of Object.values(config.env.adjust)) {
    if (typeof adjustment !== "string" || !/^\d+$/.test(adjustment)) continue
    const port = Number.parseInt(adjustment, 10)
    if (port >= 1 && port <= 65535) ports.add(port)
  }
  return [...ports]
}

/**
 * env.fileに記載された環境変数ファイルをworktreeにコピーしenv.adjustを適用
 *
 * @returns 変更されたキーごとの from/to (例: APP_PORT: 3000 → 3001)。--json の env フィールドにも使う。
 */
export interface ApplyEnvAdjustmentOptions {
  /** Reservation set shared with the Compose phase; newly assigned ports are added in place. */
  reservedPorts?: Set<number>
  /** Optional shared issue sink used by create --json/--strict. */
  issues?: SetupIssues
}

export async function applyEnvAdjustments(
  sourceRoot: string,
  targetRoot: string,
  config: WtbConfig,
  options: ApplyEnvAdjustmentOptions = {}
): Promise<Record<string, { from: string; to: string }>> {
  const issues = options.issues ?? emptySetupIssues()
  const usedPorts =
    options.reservedPorts ??
    new Set<number>([
      ...collectWorktreeEnvPorts(targetRoot, config),
      ...collectWorktreeComposePorts(targetRoot, config),
    ])
  if (!options.reservedPorts) {
    // Docker が publish しているポートも除外する。問い合わせ失敗を空集合として
    // 扱うと衝突ポートを採番するため strict に伝播する。
    for (const p of getUsedPortsOrThrow()) usedPorts.add(p)
  }
  // String replacements (including keys absent from the source file) are fixed
  // values. Reserve them before processing any numeric allocator in any file.
  for (const port of configuredFixedEnvPorts(config)) usedPorts.add(port)
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
  const configuredEnvTargets = new Set<string>()

  // ── Pass 1: 既存挙動（env.file ごとに copyAndAdjustEnvFile） ──────────────────
  for (const relativePath of config.env.file) {
    try {
      const sourcePath = resolveRepositoryPath(sourceRoot, relativePath, {
        field: "env.file source",
        rejectSymlinkAncestors: true,
      })
      let targetPath = resolveRepositoryPath(targetRoot, relativePath, {
        field: "env.file target",
        rejectSymlinkAncestors: true,
      })
      configuredEnvTargets.add(targetPath)

      if (!existsSync(sourcePath)) {
        const message = `Source not found: ${relativePath}`
        out(`  ⚠️  Skip (not found): ${relativePath}`)
        addSetupIssue(issues, "warning", { phase: "env", path: relativePath, message })
        continue
      }

      await fs.ensureDir(path.dirname(targetPath))
      targetPath = resolveRepositoryPath(targetRoot, relativePath, {
        field: "env.file target",
        rejectSymlinkAncestors: true,
      })
      const changes: EnvAdjustmentChange[] = []
      const adjustedCount = copyAndAdjustEnvFile(
        sourcePath,
        targetPath,
        config.env.adjust,
        undefined,
        [...usedPorts],
        changes
      )
      copiedTargets.add(targetPath)
      changesByTarget.set(targetPath, changes)
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
        if (!Number.isNaN(toPort)) usedPorts.add(toPort)
      }
    } catch (error) {
      const message = getErrorMessage(error)
      out(`  ❌ Failed to adjust ${relativePath}: ${message}`)
      addSetupIssue(issues, "failure", { phase: "env", path: relativePath, message })
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
    if (unionMap.size > 0) {
      const filesToPropagate = Array.from(new Set([...config.env.file, ...propagation.files]))
      const processedTargets = new Set<string>()

      for (const relativePath of filesToPropagate) {
        try {
          const sourcePath = resolveRepositoryPath(sourceRoot, relativePath, {
            field: "env.port_propagation.files source",
            rejectSymlinkAncestors: true,
          })
          let targetPath = resolveRepositoryPath(targetRoot, relativePath, {
            field: "env.port_propagation.files target",
            rejectSymlinkAncestors: true,
          })
          if (processedTargets.has(targetPath)) continue
          processedTargets.add(targetPath)

          // M7: env.file は「そのファイル自身の pass-1 bump」から作った map を使う。
          // propagation-only ファイルは union map を使う (自分の bump を持たないため)。
          const portMap = configuredEnvTargets.has(targetPath)
            ? buildPortMap(changesByTarget.get(targetPath) ?? [])
            : unionMap

          if (!existsSync(sourcePath)) {
            // env.file の欠落は pass 1 で既に報告済み。propagation-only の欠落だけ追加する。
            if (!configuredEnvTargets.has(targetPath)) {
              const message = `Propagation source not found: ${relativePath}`
              out(`  ⚠️  Skip propagation (source not found): ${relativePath}`)
              addSetupIssue(issues, "warning", {
                phase: "env",
                path: relativePath,
                message,
              })
            }
            continue
          }

          // このファイル固有の map が空なら伝播対象が無いのでスキップ。
          if (portMap.size === 0) continue

          await fs.ensureDir(path.dirname(targetPath))
          targetPath = resolveRepositoryPath(targetRoot, relativePath, {
            field: "env.port_propagation.files target",
            rejectSymlinkAncestors: true,
          })
          const source = parseEnvFile(sourcePath)
          const alreadyCopied = copiedTargets.has(targetPath)
          // A propagation-only file can be transformed directly from its source
          // representation, avoiding a non-atomic source→target copy first.
          const target = alreadyCopied ? parseEnvFile(targetPath) : parseEnvFile(sourcePath)
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

          if (propagated > 0 || !alreadyCopied) {
            writeEnvFile(targetPath, target)
            copiedTargets.add(targetPath)
          }
          if (propagated > 0) {
            out(`  🔁 Propagated ${propagated} port reference(s): ${relativePath}`)
          }
        } catch (error) {
          const message = getErrorMessage(error)
          out(`  ❌ Failed to propagate ${relativePath}: ${message}`)
          addSetupIssue(issues, "failure", {
            phase: "env",
            path: relativePath,
            message,
          })
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
    try {
      const targetPath = resolveRepositoryPath(targetRoot, relativePath, {
        field: "managed env target",
        rejectSymlinkAncestors: true,
      })
      if (copiedTargets.has(targetPath)) {
        if (markWtbManagedFile(targetRoot, relativePath) === false) {
          const message = "Failed to persist managed-file metadata"
          out(`  ❌ Failed to mark managed env file ${relativePath}: ${message}`)
          addSetupIssue(issues, "failure", { phase: "env", path: relativePath, message })
        }
      }
    } catch (error) {
      const message = getErrorMessage(error)
      out(`  ❌ Failed to mark managed env file ${relativePath}: ${message}`)
      addSetupIssue(issues, "failure", { phase: "env", path: relativePath, message })
    }
  }

  return allChanges
}
