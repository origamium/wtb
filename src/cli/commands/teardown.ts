/** Clean up an existing environment while leaving Git and the worktree intact. */
import { existsSync } from "node:fs"
import * as path from "node:path"
import { Command } from "commander"
import { EXIT_CODES } from "../../constants/index.js"
import {
  assertComposeVolumesSafeForRemoval,
  DockerVolumeInspectionError,
} from "../../core/docker/volume-removal.js"
import {
  assertWorktreeComposeContext,
  resolveWorktreeContext,
  type WorktreeComposeContext,
  type WorktreeContext,
} from "../../core/docker/worktree-context.js"
import { assertSetupNotInProgress, markSetupTornDown } from "../../core/environment/setup-state.js"
import { acquireRepositoryLock } from "../../core/git/repository.js"
import { CLIError, getErrorMessage } from "../../utils/error.js"
import { executeLifecycleCommand, withExecDeadline } from "../../utils/exec.js"
import { out, setJsonOutputMode } from "../../utils/output.js"
import { withErrorHandling } from "../utils/command-helpers.js"
import { ComposeLifecycleError, runWorktreeComposeLifecycle } from "./updown.js"

export interface TeardownOptions {
  json?: boolean
  removeVolumes?: boolean
  dryRun?: boolean
}

export interface TeardownResult {
  branch: string | null
  path: string | null
  dryRun: boolean
  removed: false
  tornDown: boolean
  composeDown: { ran: boolean; failed: boolean; volumesRemoved: boolean } | null
  endCommand: { ran: boolean; failed: boolean } | null
  cleanupErrors: string[]
  ok: boolean
}

export class TeardownError extends CLIError {
  constructor(
    message: string,
    exitCode: number,
    public readonly result: TeardownResult
  ) {
    super(message, exitCode)
  }
}

/** end_command may remove volumes itself, so verify all ownership before invoking it. */
async function validateTeardownVolumes(
  context: WorktreeContext | WorktreeComposeContext,
  markBeforeCleanup = false
): Promise<void> {
  const release = await acquireRepositoryLock(context.repository, { waitTimeoutMs: 5000 })
  try {
    assertSetupNotInProgress(context.worktreePath)
    if ("composePath" in context) {
      assertComposeVolumesSafeForRemoval(
        context.composePath,
        context.repository.mainRoot,
        context.targetProject,
        context.targetBranch,
        context.repository.commonGitDir
      )
    }
    // A failed hook/down can already have removed data. Invalidate the complete
    // setup record before the first mutation so setup cannot later reuse it.
    if (markBeforeCleanup) markSetupTornDown(context.worktreePath)
  } finally {
    await release()
  }
}

export async function runWorktreeTeardown(
  branch: string | undefined,
  options: TeardownOptions = {}
): Promise<TeardownResult> {
  const result: TeardownResult = {
    branch: branch ?? null,
    path: null,
    dryRun: options.dryRun === true,
    removed: false,
    tornDown: false,
    composeDown: null,
    endCommand: null,
    cleanupErrors: [],
    ok: false,
  }
  try {
    // Orca's archive hook allows 120 seconds; retain a margin for reporting failure.
    return await withExecDeadline(110_000, async () => {
      const context = resolveWorktreeContext(branch, "teardown")
      const { config, worktreePath, targetBranch } = context
      result.branch = targetBranch
      result.path = worktreePath
      if (config.end_command) result.endCommand = { ran: false, failed: false }
      let composeContext: WorktreeComposeContext | undefined
      if (config.docker_compose_file) {
        result.composeDown = { ran: false, failed: false, volumesRemoved: false }
        try {
          composeContext = assertWorktreeComposeContext(context, "teardown")
          await validateTeardownVolumes(composeContext, options.dryRun !== true)
        } catch (error) {
          result.composeDown.failed = true
          throw error
        }
      } else {
        await validateTeardownVolumes(context, options.dryRun !== true)
      }

      if (options.dryRun) {
        if (config.end_command) out(`Would run end command: ${config.end_command}`)
        if (composeContext) {
          out(
            `Would stop Compose project '${composeContext.targetProject}'${options.removeVolumes ? " and remove its owned volumes" : ""}`
          )
        }
        result.ok = true
        return result
      }

      if (config.end_command && result.endCommand) {
        out(`🛑 Running end command: ${config.end_command}`)
        result.endCommand.ran = true
        try {
          const scriptPath = path.resolve(worktreePath, config.end_command)
          const command = existsSync(scriptPath)
            ? `'${scriptPath.replace(/'/g, "'\\''")}'`
            : config.end_command
          executeLifecycleCommand(command, worktreePath)
        } catch (error) {
          result.endCommand.failed = true
          throw new CLIError(
            `end_command failed: ${getErrorMessage(error)}`,
            EXIT_CODES.GENERAL_ERROR
          )
        }
      }

      if (composeContext && result.composeDown) {
        try {
          // The user hook may change files/resources. Never trust the pre-hook snapshot.
          const refreshed = assertWorktreeComposeContext(context, "teardown")
          if (
            refreshed.targetProject !== composeContext.targetProject ||
            refreshed.composePath !== composeContext.composePath
          ) {
            throw new CLIError("Compose identity changed during end_command; refusing cleanup")
          }
          await validateTeardownVolumes(refreshed)
          const down = await runWorktreeComposeLifecycle("down", targetBranch, {
            removeVolumes: options.removeVolumes,
            lockWaitTimeoutMs: 5000,
          })
          result.composeDown.ran = true
          result.composeDown.volumesRemoved = down.volumesRemoved === true
        } catch (error) {
          result.composeDown.failed = true
          if (error instanceof ComposeLifecycleError) {
            result.composeDown.ran = error.dockerCommandRan
          }
          throw error
        }
      }
      result.tornDown = true
      result.ok = true
      out(`✅ Environment torn down; worktree kept at ${worktreePath}`)
      return result
    })
  } catch (error) {
    result.ok = false
    result.cleanupErrors.push(getErrorMessage(error))
    throw new TeardownError(
      getErrorMessage(error),
      error instanceof CLIError
        ? error.exitCode
        : error instanceof DockerVolumeInspectionError
          ? EXIT_CODES.DOCKER_ERROR
          : EXIT_CODES.GENERAL_ERROR,
      result
    )
  }
}

export function teardownCommand(): Command {
  return new Command("teardown")
    .description("Stop and clean up a worktree's environment without removing its Git worktree")
    .argument("[branch]", "Target branch (default: the current worktree)")
    .option("--remove-volumes", "Also remove this worktree's owned, non-external volumes")
    .option("--dry-run", "Validate and preview cleanup without changing the environment")
    .option("--json", "Output one machine-readable result on stdout")
    .action(
      withErrorHandling(async (branch: string | undefined, options: TeardownOptions) => {
        setJsonOutputMode(options.json === true)
        try {
          const result = await runWorktreeTeardown(branch, options)
          if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        } catch (error) {
          if (!options.json || !(error instanceof TeardownError)) throw error
          process.stdout.write(`${JSON.stringify(error.result, null, 2)}\n`)
          process.exitCode = error.exitCode
          console.error(`Error: ${error.message}`)
        }
      })
    )
}
