/**
 * @fileoverview up / down コマンド実装
 *
 * worktree の Docker Compose スタックを worktree 自身の project 名で起動/破棄する。
 * 素の `docker compose up/down` と違い、`-f`(worktree 内 compose) と `-p`(target
 * project) を常に明示するため、COMPOSE_PROJECT_NAME や固定 `name:` によって source
 * スタックを誤って操作する事故を防ぐ (remove.ts の teardown ガードと同じ防御を、
 * docker 操作が目的そのものであるこのコマンドでは hard-fail として適用する)。
 */

import { Command } from "commander"
import { EXIT_CODES } from "../../constants/index.js"
import {
  assertComposeNetworkingSafe,
  assertComposeStorageDefinitionsSafe,
  composeDown,
  composeUp,
  readComposeFile,
  withComposeSnapshot,
} from "../../core/docker/compose.js"
import { DockerComposeProjectInspectionError } from "../../core/docker/project-ownership.js"
import {
  acquireTargetVolumeLifecycleLeases,
  getVolumeRecoveryDirectory,
  readVolumeRecoveryRecords,
  repoVolumeLabel,
  resolveVolumeName,
  type TargetVolumeLifecycleLease,
} from "../../core/docker/volume.js"
import {
  assertComposeVolumesSafeForRemoval,
  DockerVolumeInspectionError,
} from "../../core/docker/volume-removal.js"
import { resolveWorktreeComposeContext } from "../../core/docker/worktree-context.js"
import { acquireRepositoryLock } from "../../core/git/repository.js"
import { CLIError, getErrorMessage } from "../../utils/error.js"
import { out, setJsonOutputMode } from "../../utils/output.js"
import { withErrorHandling } from "../utils/command-helpers.js"

interface UpDownOptions {
  json?: boolean
  removeVolumes?: boolean
}

/**
 * upコマンドを作成
 */
export function upCommand(): Command {
  return new Command("up")
    .description(
      "Start a worktree's Docker Compose stack (docker compose up -d with the worktree's own project)"
    )
    .argument("[branch]", "Branch whose worktree to start (default: the current worktree)")
    .option(
      "--json",
      "Output one machine-readable JSON result on stdout (human progress goes to stderr)"
    )
    .action(
      withErrorHandling((branch: string | undefined, options: UpDownOptions) =>
        runComposeLifecycle("up", branch, options)
      )
    )
}

/**
 * downコマンドを作成
 */
export function downCommand(): Command {
  return new Command("down")
    .description(
      "Stop a worktree's Docker Compose stack (docker compose down with the worktree's own project)"
    )
    .argument("[branch]", "Branch whose worktree to stop (default: the current worktree)")
    .option(
      "--remove-volumes",
      "Also delete this worktree's Docker volumes (docker compose down -v)"
    )
    .option(
      "--json",
      "Output one machine-readable JSON result on stdout (human progress goes to stderr)"
    )
    .action(
      withErrorHandling((branch: string | undefined, options: UpDownOptions) =>
        runComposeLifecycle("down", branch, options)
      )
    )
}

export interface ComposeLifecycleResult {
  branch: string
  path: string
  composeFile: string
  project: string
  action: "up" | "down"
  ok: boolean
  volumesRemoved?: boolean
}

export class ComposeLifecycleError extends CLIError {
  constructor(
    message: string,
    exitCode: number,
    public readonly dockerCommandRan: boolean
  ) {
    super(message, exitCode)
  }
}

/** Shared lifecycle primitive: throws on failure, without JSON or process exit effects. */
export async function runWorktreeComposeLifecycle(
  action: "up" | "down",
  branch: string | undefined,
  options: { removeVolumes?: boolean; lockWaitTimeoutMs?: number } = {}
): Promise<ComposeLifecycleResult> {
  const { repository, worktreePath, targetBranch, composePath, targetProject } =
    resolveWorktreeComposeContext(branch, action)
  const gitRoot = repository.mainRoot
  const removeVolumes = action === "down" && options.removeVolumes === true

  if (action === "up") {
    out(`🐳 Starting Docker Compose stack for branch: ${targetBranch}`)
  } else {
    out(
      removeVolumes
        ? `🐳 Stopping Docker Compose stack and removing volumes for branch: ${targetBranch}`
        : `🐳 Stopping Docker Compose stack for branch: ${targetBranch}`
    )
  }
  out(`📂 Worktree path: ${worktreePath}`)
  out(`📦 Compose project: ${targetProject}`)

  let targetLease: TargetVolumeLifecycleLease | undefined
  const releaseDestructiveRepositoryLock = removeVolumes
    ? await acquireRepositoryLock(repository, { waitTimeoutMs: options.lockWaitTimeoutMs })
    : undefined
  let dockerCommandRan = false
  let lifecycleError: unknown
  const cleanupErrors: unknown[] = []
  try {
    const validatedCompose = removeVolumes
      ? assertComposeVolumesSafeForRemoval(
          composePath,
          gitRoot,
          targetProject,
          targetBranch,
          repository.commonGitDir
        )
      : (() => {
          const compose = readComposeFile(composePath)
          assertComposeStorageDefinitionsSafe(compose)
          // Never start an older, manually edited, or --no-docker checkout that
          // bypassed create's per-worktree networking isolation. Down remains
          // available so an already-running unsafe stack can still be stopped.
          if (action === "up") assertComposeNetworkingSafe(compose)
          return compose
        })()

    if (removeVolumes) {
      const recoveryTargets = new Set(
        readVolumeRecoveryRecords(getVolumeRecoveryDirectory(repository.commonGitDir)).map(
          ({ record }) => record.targetVolume
        )
      )
      for (const key of Object.keys(validatedCompose.volumes ?? {})) {
        const resolved = resolveVolumeName(validatedCompose, key, targetProject)
        if (resolved && !resolved.external && recoveryTargets.has(resolved.name)) {
          throw new Error(
            `Refusing to remove target volume '${resolved.name}' while its recovery record is unresolved`
          )
        }
      }
    }

    if (action === "up") {
      const releaseRepositoryLock = await acquireRepositoryLock(repository, {
        waitTimeoutMs: options.lockWaitTimeoutMs,
      })
      try {
        const recoveryTargets = new Set(
          readVolumeRecoveryRecords(getVolumeRecoveryDirectory(repository.commonGitDir)).map(
            ({ record }) => record.targetVolume
          )
        )
        const targetVolumes: string[] = []
        for (const key of Object.keys(validatedCompose.volumes ?? {})) {
          const resolved = resolveVolumeName(validatedCompose, key, targetProject)
          if (!resolved || resolved.external) continue
          if (recoveryTargets.has(resolved.name)) {
            throw new Error(`Target volume '${resolved.name}' has an unresolved recovery record`)
          }
          targetVolumes.push(resolved.name)
        }
        targetLease = acquireTargetVolumeLifecycleLeases(targetVolumes, {
          repo: repoVolumeLabel(gitRoot),
          project: targetProject,
          branch: targetBranch,
        })
      } finally {
        await releaseRepositoryLock()
      }
      withComposeSnapshot(composePath, validatedCompose, (snapshotPath) => {
        dockerCommandRan = true
        composeUp(snapshotPath, targetProject, worktreePath)
      })
    } else {
      withComposeSnapshot(composePath, validatedCompose, (snapshotPath) => {
        dockerCommandRan = true
        composeDown(snapshotPath, targetProject, worktreePath, removeVolumes)
      })
    }
  } catch (error) {
    lifecycleError = error
  } finally {
    if (targetLease) {
      try {
        targetLease.release()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (releaseDestructiveRepositoryLock) {
      try {
        await releaseDestructiveRepositoryLock()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
  }

  if (lifecycleError !== undefined || cleanupErrors.length > 0) {
    const details = [
      ...(lifecycleError !== undefined
        ? [`docker compose ${action} failed: ${getErrorMessage(lifecycleError)}`]
        : []),
      ...cleanupErrors.map(
        (error) => `failed to release a safety lock/lease: ${getErrorMessage(error)}`
      ),
    ]
    throw new ComposeLifecycleError(
      details.join("; "),
      dockerCommandRan ||
        lifecycleError instanceof DockerVolumeInspectionError ||
        lifecycleError instanceof DockerComposeProjectInspectionError ||
        cleanupErrors.length > 0
        ? EXIT_CODES.DOCKER_ERROR
        : EXIT_CODES.GENERAL_ERROR,
      dockerCommandRan
    )
  }

  out("")
  out(action === "up" ? "✅ Compose stack is up" : "✅ Compose stack is down")

  return {
    branch: targetBranch,
    path: worktreePath,
    composeFile: composePath,
    project: targetProject,
    action,
    ok: true,
    ...(action === "down" ? { volumesRemoved: removeVolumes } : {}),
  }
}

async function runComposeLifecycle(
  action: "up" | "down",
  branch: string | undefined,
  options: UpDownOptions
): Promise<void> {
  setJsonOutputMode(options.json === true)
  try {
    const result = await runWorktreeComposeLifecycle(action, branch, options)
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    if (!options.json) throw error
    process.stdout.write(
      `${JSON.stringify(
        {
          branch: branch ?? null,
          path: null,
          composeFile: null,
          project: null,
          action,
          ok: false,
          error: getErrorMessage(error),
          ...(action === "down" ? { volumesRemoved: false } : {}),
        },
        null,
        2
      )}\n`
    )
    process.exitCode = error instanceof CLIError ? error.exitCode : EXIT_CODES.GENERAL_ERROR
    console.error(`Error: ${getErrorMessage(error)}`)
  }
}
