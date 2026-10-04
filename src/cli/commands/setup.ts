import * as path from "node:path"
import { Command } from "commander"
import { EXIT_CODES } from "../../constants/index.js"
import { loadConfig } from "../../core/config/loader.js"
import { resolveRepositoryPath } from "../../core/config/paths.js"
import {
  assertFreshSetupTargets,
  assertSetupArtifactsUnchanged,
  assertSetupNotInProgress,
  captureSetupArtifacts,
  readSetupState,
  SETUP_RECOVERY,
  setupFingerprint,
  type SetupState,
  writeSetupState,
} from "../../core/environment/setup-state.js"
import { acquireRepositoryLock, getRepositoryContext } from "../../core/git/repository.js"
import { canonicalPath, isSamePath, listWorktrees } from "../../core/git/worktree.js"
import type { WtbConfig } from "../../types/index.js"
import { CLIError, getErrorMessage } from "../../utils/error.js"
import { out, setJsonOutputMode } from "../../utils/output.js"
import { resolveWorktreeTarget } from "../utils/command-helpers.js"
import { parseAwaitTimeout, type AwaitResult, waitForWorktree } from "./await.js"
import {
  type CreateOptions,
  type EnvironmentSetupResult,
  prepareWorktreeEnvironment,
} from "./create.js"
import { runRelocatabilityPreflight } from "./doctor.js"
import { type ComposeLifecycleResult, runWorktreeComposeLifecycle } from "./updown.js"

export interface SetupOptions extends CreateOptions {
  up?: boolean
  wait?: boolean
  timeout?: number
}

export interface SetupResult {
  branch: string | null
  path: string | null
  prepared: boolean
  reused: boolean
  dryRun: boolean
  setup: EnvironmentSetupResult | null
  up: ComposeLifecycleResult | null
  readiness: AwaitResult | null
  ok: boolean
  exitCode: number
  error?: string
  recovery?: string
}

function preparationOptions(options: SetupOptions) {
  return {
    docker: options.docker !== false,
    copy: options.copy !== false,
    link: options.link !== false,
    env: options.env !== false,
    start: options.start !== false,
    volumeCopy: options.volumeCopy !== false,
    stop: options.stop !== false,
    seed: options.seed === true,
  }
}

function setupTargets(worktreePath: string, config: WtbConfig, options: SetupOptions): string[] {
  const files = [
    ...(options.copy === false ? [] : config.copy_files),
    ...(options.link === false ? [] : config.link_files),
    ...(options.env === false ? [] : config.env.file),
    ...(options.docker === false || !config.docker_compose_file
      ? []
      : [config.docker_compose_file]),
    ...(options.env === false || !config.env.port_propagation?.enabled
      ? []
      : config.env.port_propagation.files),
  ]
  const normalized = [
    ...new Set(
      files.map((relative) =>
        path
          .relative(
            worktreePath,
            resolveRepositoryPath(worktreePath, relative, {
              field: "setup target",
              rejectSymlinkAncestors: true,
            })
          )
          .split(path.sep)
          .join("/")
      )
    ),
  ]
  return normalized
    .filter(
      (relative) =>
        !normalized.some((parent) => parent !== relative && relative.startsWith(`${parent}/`))
    )
    .sort()
}

/** Prepare an existing linked worktree once; incomplete work is preserved for manual recovery. */
export async function setupWorktree(
  branch: string | undefined,
  options: SetupOptions = {}
): Promise<SetupResult> {
  const result: SetupResult = {
    branch: branch ?? null,
    path: null,
    prepared: false,
    reused: false,
    dryRun: options.dryRun === true,
    setup: null,
    up: null,
    readiness: null,
    ok: false,
    exitCode: 0,
  }
  let releaseLock: Awaited<ReturnType<typeof acquireRepositoryLock>> | undefined
  let state: SetupState | null = null
  let ownsState = false
  let ownsActivation = false
  try {
    const repository = getRepositoryContext()
    const { worktreePath, targetBranch } = resolveWorktreeTarget("setup", branch)
    result.path = worktreePath
    result.branch = targetBranch
    if (isSamePath(worktreePath, repository.mainRoot))
      throw new CLIError("Refusing to setup the main repository worktree")
    const target = listWorktrees(repository.mainRoot).find((wt) =>
      isSamePath(wt.path, worktreePath)
    )
    if (!target || target.detached || target.locked || target.prunable || !targetBranch) {
      throw new CLIError("Setup requires an unlocked, attached, registered Git worktree")
    }
    if (
      process.env.ORCA_WORKTREE_PATH &&
      !isSamePath(process.env.ORCA_WORKTREE_PATH, worktreePath)
    ) {
      throw new CLIError("ORCA_WORKTREE_PATH does not match the setup target")
    }
    const config = loadConfig(repository.mainRoot)
    if (options.seed && (!config.volumes?.seed_command || options.docker === false)) {
      throw new CLIError(
        "--seed requires volumes.seed_command and cannot be combined with --no-docker",
        EXIT_CODES.CONFIG_ERROR
      )
    }
    if ((options.up || options.wait) && options.docker === false) {
      throw new CLIError(
        "--up/--wait cannot be combined with --no-docker",
        EXIT_CODES.INVALID_USAGE
      )
    }
    if (
      options.timeout !== undefined &&
      (!Number.isFinite(options.timeout) ||
        options.timeout <= 0 ||
        !Number.isSafeInteger(Math.ceil(options.timeout * 1000)))
    ) {
      throw new CLIError("Timeout must be a positive number of seconds", EXIT_CODES.INVALID_USAGE)
    }
    const fingerprint = setupFingerprint({ config, options: preparationOptions(options) })
    const targets = setupTargets(worktreePath, config, options)
    if (!result.dryRun) releaseLock = await acquireRepositoryLock(repository)
    const releaseAllocationLock = async () => {
      if (releaseLock) {
        await releaseLock()
        releaseLock = undefined
      }
    }
    state = readSetupState(worktreePath)
    if (state) {
      assertSetupNotInProgress(worktreePath)
      if (state.status !== "complete")
        throw new CLIError(
          `Setup state is ${state.status} (phase ${state.phase}). ${SETUP_RECOVERY}`
        )
      if (
        state.commonGitDir !== repository.commonGitDir ||
        state.branch !== targetBranch ||
        state.fingerprint !== fingerprint
      ) {
        throw new CLIError(`Setup configuration or worktree identity changed. ${SETUP_RECOVERY}`)
      }
      if (JSON.stringify(Object.keys(state.artifacts).sort()) !== JSON.stringify(targets)) {
        throw new CLIError(`Setup artifact manifest is incomplete. ${SETUP_RECOVERY}`)
      }
      assertSetupArtifactsUnchanged(worktreePath, state)
      if (!result.dryRun && config.docker_compose_file && (options.up || options.wait)) {
        state.phase = "up"
        state.pid = process.pid
        writeSetupState(worktreePath, state)
        ownsActivation = true
      }
      result.prepared = true
      result.reused = true
      out(
        "ℹ️  Reusing verified environment setup; copy, port allocation, data and start_command are not repeated"
      )
      await releaseAllocationLock()
    } else {
      assertFreshSetupTargets(
        worktreePath,
        repository.mainRoot,
        targets,
        options.link === false ? [] : config.link_files.map((value) => path.normalize(value))
      )
      runRelocatabilityPreflight(repository.mainRoot, config)
      if (!result.dryRun) {
        state = {
          version: 1,
          path: canonicalPath(worktreePath),
          commonGitDir: repository.commonGitDir,
          branch: targetBranch,
          fingerprint,
          status: "preparing",
          phase: "preflight",
          pid: process.pid,
          artifacts: {},
        }
        writeSetupState(worktreePath, state)
        ownsState = true
      }
      const prepared = await prepareWorktreeEnvironment({
        repository,
        worktreePath,
        branch: targetBranch,
        config,
        options,
        releaseAllocationLock,
        onPhase: (phase) => {
          if (state && ownsState) {
            state.phase = phase
            writeSetupState(worktreePath, state)
          }
        },
      })
      result.setup = prepared
      if (
        prepared.sourceRestartFailed ||
        prepared.volumeFailures ||
        prepared.seedFailed ||
        prepared.composeFailed ||
        prepared.startCommandFailed ||
        prepared.setupIssues.failures.length
      ) {
        if (state && ownsState)
          state.phase =
            prepared.setupIssues.failures[0]?.phase ??
            (prepared.volumeFailures || prepared.seedFailed || prepared.sourceRestartFailed
              ? "volumes"
              : "compose")
        throw new CLIError(
          "Environment setup failed; see setup phase results",
          prepared.sourceRestartFailed ? EXIT_CODES.DOCKER_ERROR : EXIT_CODES.GENERAL_ERROR
        )
      }
      if (state && ownsState) {
        state.artifacts = captureSetupArtifacts(worktreePath, targets)
        state.status = "complete"
        state.phase = config.docker_compose_file && (options.up || options.wait) ? "up" : "complete"
        ownsActivation = state.phase === "up"
        writeSetupState(worktreePath, state)
        ownsState = false
      }
      result.prepared = !result.dryRun
    }
    if (config.docker_compose_file && (options.up || options.wait)) {
      if (result.dryRun) out("  [dry-run] Would start the target Compose stack")
      else result.up = await runWorktreeComposeLifecycle("up", targetBranch)
    }
    if (config.docker_compose_file && options.wait) {
      if (result.dryRun)
        out(`  [dry-run] Would await readiness (timeout ${options.timeout ?? 120}s)`)
      else {
        if (state && ownsActivation) {
          state.phase = "await"
          writeSetupState(worktreePath, state)
        }
        result.readiness = await waitForWorktree(targetBranch, { timeout: options.timeout })
        if (!result.readiness.ok)
          throw new CLIError(
            result.readiness.timedOut
              ? "Compose readiness timed out"
              : "Compose services are not ready"
          )
      }
    }
    result.ok = true
    return result
  } catch (error) {
    result.error = getErrorMessage(error)
    result.exitCode = error instanceof CLIError ? error.exitCode : EXIT_CODES.GENERAL_ERROR
    if (state && ownsState && result.path) {
      state.status = "failed"
      state.error = result.error
      try {
        writeSetupState(result.path, state)
      } catch (recordError) {
        result.error += `; could not update setup record: ${getErrorMessage(recordError)}`
      }
      result.recovery = SETUP_RECOVERY
    } else if (state && state.status !== "complete") result.recovery = SETUP_RECOVERY
    return result
  } finally {
    if (state && ownsActivation && result.path) {
      try {
        state.phase = "complete"
        writeSetupState(result.path, state)
      } catch (error) {
        result.ok = false
        result.exitCode = EXIT_CODES.GENERAL_ERROR
        result.error = `Could not finalize setup readiness state: ${getErrorMessage(error)}`
      }
    }
    if (releaseLock) {
      try {
        await releaseLock()
      } catch (error) {
        result.ok = false
        if (result.exitCode === 0) result.exitCode = EXIT_CODES.GENERAL_ERROR
        result.error = [result.error, `Could not release setup lock: ${getErrorMessage(error)}`]
          .filter(Boolean)
          .join("; ")
      }
    }
  }
}

export function setupCommand(): Command {
  return new Command("setup")
    .description("Prepare an existing linked worktree once (fails non-zero on incomplete setup)")
    .argument("[branch]", "Target branch (default: current worktree)")
    .option("--up", "Start the prepared Compose stack")
    .option("--wait", "Start Compose and wait until its services are ready")
    .option("--timeout <seconds>", "Readiness timeout in seconds", parseAwaitTimeout, 120)
    .option("--seed", "Run volumes.seed_command instead of cloning data")
    .option("--no-docker", "Skip Compose setup and volume cloning")
    .option("--no-env", "Skip environment files")
    .option("--no-copy", "Skip configured copies")
    .option("--no-link", "Skip configured symlinks")
    .option("--no-start", "Skip start_command")
    .option("--no-volume-copy", "Skip volume cloning")
    .option("--no-stop", "Skip in-use source volumes instead of stopping the source stack")
    .option("--dry-run", "Preview without modifying the worktree")
    .option("--json", "Write one JSON result to stdout")
    .action(async (branch: string | undefined, options: SetupOptions) => {
      setJsonOutputMode(options.json === true)
      const result = await setupWorktree(branch, options)
      if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      else
        out(
          result.ok
            ? result.dryRun
              ? "Setup preview complete"
              : "Worktree environment is ready"
            : `Error: ${result.error}`
        )
      if (!result.ok) {
        if (options.json) console.error(result.error)
        if (result.recovery) console.error(result.recovery)
        process.exitCode = result.exitCode
      }
    })
}
