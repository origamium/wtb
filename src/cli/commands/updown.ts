/**
 * @fileoverview up / down コマンド実装
 *
 * worktree の Docker Compose スタックを worktree 自身の project 名で起動/破棄する。
 * 素の `docker compose up/down` と違い、`-f`(worktree 内 compose) と `-p`(target
 * project) を常に明示するため、COMPOSE_PROJECT_NAME や固定 `name:` によって source
 * スタックを誤って操作する事故を防ぐ (remove.ts の teardown ガードと同じ防御を、
 * docker 操作が目的そのものであるこのコマンドでは hard-fail として適用する)。
 */

import { existsSync } from "node:fs"
import { Command } from "commander"
import { EXIT_CODES } from "../../constants/index.js"
import { loadConfig } from "../../core/config/loader.js"
import { resolveRepositoryPath } from "../../core/config/paths.js"
import {
  assertComposeNetworkingSafe,
  assertComposeStorageDefinitionsSafe,
  composeDown,
  composeUp,
  readComposeFile,
  safeResolveComposeProjectName,
  withComposeSnapshot,
} from "../../core/docker/compose.js"
import {
  assertComposeProjectUnique,
  assertDockerComposeProjectOwnedByWorktree,
  DockerComposeProjectInspectionError,
} from "../../core/docker/project-ownership.js"
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
import { acquireRepositoryLock, getRepositoryContext } from "../../core/git/repository.js"
import { isSamePath, listWorktrees } from "../../core/git/worktree.js"
import { CLIError, getErrorMessage } from "../../utils/error.js"
import { out, setJsonOutputMode } from "../../utils/output.js"
import { resolveWorktreeTarget, withErrorHandling } from "../utils/command-helpers.js"

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

/**
 * up / down 共通の実行ロジック
 */
async function runComposeLifecycle(
  action: "up" | "down",
  branch: string | undefined,
  options: UpDownOptions
): Promise<void> {
  // モジュール状態なので毎回明示的に設定する (前回実行のモードを引き継がない)。
  const json = options.json === true
  setJsonOutputMode(json)

  // NOTE: getGitRootOrThrow (--show-toplevel) は worktree 内では worktree 自身を返すため
  // 使えない — source を指す main worktree root が必要 (でないと worktree 内からの実行が
  // 常に main-repo ガードで拒否され、same-project ガードの source 側も誤解決する)。
  const repository = getRepositoryContext()
  const gitRoot = repository.mainRoot
  const { worktreePath, targetBranch } = resolveWorktreeTarget(action, branch)

  // main repo は wtb の管理対象外 (per-worktree identity が無い)。誤って source の
  // スタックを worktree 用ガードの文脈で操作しないよう拒否する。
  if (isSamePath(worktreePath, gitRoot)) {
    throw new CLIError(
      `Refusing to run '${action}' against the main repository worktree — run 'docker compose ${action}' directly in the source repository instead.`,
      EXIT_CODES.GENERAL_ERROR
    )
  }

  const config = loadConfig(gitRoot)
  if (!config.docker_compose_file) {
    throw new CLIError(
      "No docker_compose_file is configured — there is no Compose stack for wtb to manage. Set docker_compose_file in your wtb config.",
      EXIT_CODES.CONFIG_ERROR
    )
  }

  // compose は必ず worktree 内のものを使う。gitRoot の compose にフォールバックすると、
  // source のリテラルなポート定義を worktree の project 名で up することになり、source と
  // ポート衝突する (create が書き換えた per-worktree compose だけが安全)。
  const composePath = resolveRepositoryPath(worktreePath, config.docker_compose_file, {
    field: "docker_compose_file target",
    rejectSymlinkAncestors: true,
  })
  if (!existsSync(composePath)) {
    throw new CLIError(
      `No compose file at ${config.docker_compose_file} inside the worktree (${worktreePath}) — cannot run 'docker compose ${action}' for it.`,
      EXIT_CODES.GENERAL_ERROR
    )
  }

  // same-project ガード (remove.ts の teardown ガードと対)。docker を呼ぶこと自体が
  // このコマンドの目的なので、warning + skip ではなく hard-fail する。
  const sourceComposePath = resolveRepositoryPath(gitRoot, config.docker_compose_file, {
    field: "docker_compose_file source",
    rejectSymlinkAncestors: true,
  })
  const sourceComposeExists = existsSync(sourceComposePath)
  const sourceProject = sourceComposeExists
    ? safeResolveComposeProjectName(sourceComposePath, gitRoot)
    : undefined
  const targetProject = safeResolveComposeProjectName(composePath, worktreePath)
  if (sourceComposeExists && sourceProject === null) {
    throw new CLIError(
      `Could not resolve the source Compose project — refusing to run 'docker compose ${action}' without proving project ownership.`,
      EXIT_CODES.GENERAL_ERROR
    )
  }
  if (targetProject === null) {
    throw new CLIError(
      `Could not resolve this worktree's Compose project name (compose file unreadable) — refusing to run 'docker compose ${action}' against an unknown project.`,
      EXIT_CODES.GENERAL_ERROR
    )
  }
  if (sourceProject !== undefined && targetProject === sourceProject) {
    throw new CLIError(
      `This worktree resolves to the SAME Compose project as the source ('${targetProject}'), so 'docker compose ${action}' would hit your source stack. This usually means COMPOSE_PROJECT_NAME is set or the compose 'name:' is fixed. Unset COMPOSE_PROJECT_NAME or make the compose 'name:' per-worktree, then retry.`,
      EXIT_CODES.GENERAL_ERROR
    )
  }
  try {
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
    throw new CLIError(
      `Could not prove exclusive ownership of Compose project '${targetProject}': ${getErrorMessage(error)}`,
      error instanceof DockerComposeProjectInspectionError
        ? EXIT_CODES.DOCKER_ERROR
        : EXIT_CODES.GENERAL_ERROR
    )
  }

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
    ? await acquireRepositoryLock(repository)
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
      const releaseRepositoryLock = await acquireRepositoryLock(repository)
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
            throw new Error(
              `Target volume '${resolved.name}' has an unresolved recovery record`
            )
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
    throw new CLIError(
      details.join("; "),
      dockerCommandRan ||
        lifecycleError instanceof DockerVolumeInspectionError ||
        lifecycleError instanceof DockerComposeProjectInspectionError ||
        cleanupErrors.length > 0
        ? EXIT_CODES.DOCKER_ERROR
        : EXIT_CODES.GENERAL_ERROR
    )
  }

  out("")
  out(action === "up" ? "✅ Compose stack is up" : "✅ Compose stack is down")

  if (json) {
    // stdout には JSON オブジェクトを 1 つだけ出力する (人間向け出力は stderr 済み)。
    const result: Record<string, unknown> = {
      branch: targetBranch,
      path: worktreePath,
      composeFile: composePath,
      project: targetProject,
      action,
      ok: true,
    }
    if (action === "down") {
      result.volumesRemoved = removeVolumes
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }
}
