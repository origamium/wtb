import { Command, InvalidArgumentError } from "commander"
import { EXIT_CODES } from "../../constants/index.js"
import {
  assertNoComposeSourceOverrides,
  loadComposeInterpolationEnvironment,
} from "../../core/docker/compose.js"
import { DockerComposeProjectInspectionError } from "../../core/docker/project-ownership.js"
import {
  expectedComposeServices,
  evaluateReadiness,
  parseComposePs,
  pollComposeReadiness,
  type ServiceReadiness,
} from "../../core/docker/readiness.js"
import { resolveWorktreeComposeContext } from "../../core/docker/worktree-context.js"
import { CLIError, getErrorMessage } from "../../utils/error.js"
import { execDockerSafe, withExecDeadline } from "../../utils/exec.js"

export interface AwaitResult {
  branch: string
  path: string
  project: string
  composeFile: string
  ok: boolean
  timedOut: boolean
  elapsedMs: number
  services: ServiceReadiness[]
}

export function parseAwaitTimeout(value: string): number {
  if (!/^\d+(?:\.\d+)?$/.test(value) || !isValidAwaitTimeout(Number(value))) {
    throw new InvalidArgumentError(
      "Timeout must be positive seconds within the safe millisecond range"
    )
  }
  return Number(value)
}

export function isValidAwaitTimeout(timeout: number): boolean {
  return Number.isFinite(timeout) && timeout > 0 && Number.isSafeInteger(Math.ceil(timeout * 1000))
}

/** Readiness only: does not start services, print results, or set process.exitCode. */
export async function waitForWorktree(
  branch: string | undefined,
  options: { timeout?: number } = {}
): Promise<AwaitResult> {
  const timeout = options.timeout ?? 120
  if (!isValidAwaitTimeout(timeout)) {
    throw new CLIError("Timeout must be a positive number of seconds", EXIT_CODES.INVALID_USAGE)
  }
  return withExecDeadline(Math.ceil(timeout * 1000), () => waitWithinDeadline(branch, timeout))
}

async function waitWithinDeadline(
  branch: string | undefined,
  timeout: number
): Promise<AwaitResult> {
  const started = Date.now()
  const deadline = started + Math.ceil(timeout * 1000)
  let context: ReturnType<typeof resolveWorktreeComposeContext> | undefined
  let services: ServiceReadiness[] = []
  const runDocker = (args: string[]): string => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error("Readiness deadline reached")
    try {
      return execDockerSafe(args, {
        cwd: context?.worktreePath,
        timeoutMs: Math.max(1, Math.min(10_000, remaining)),
      })
    } catch (error) {
      throw new CLIError(
        `Cannot inspect Compose readiness: ${getErrorMessage(error)}`,
        EXIT_CODES.DOCKER_ERROR
      )
    }
  }
  try {
    context = resolveWorktreeComposeContext(branch, "await", { runDocker })
    const environment = loadComposeInterpolationEnvironment(context.worktreePath)
    assertNoComposeSourceOverrides(environment)
    const args = ["compose", "-f", context.composePath, "-p", context.targetProject]
    let expected: ReturnType<typeof expectedComposeServices>
    try {
      const config = runDocker([...args, "config", "--format", "json"])
      expected = expectedComposeServices(
        config,
        (environment.COMPOSE_PROFILES ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      )
    } catch (error) {
      if (error instanceof CLIError) throw error
      throw new CLIError(
        `Cannot read Compose service definitions: ${getErrorMessage(error)}`,
        EXIT_CODES.DOCKER_ERROR
      )
    }
    if (expected.length === 0) {
      throw new CLIError(
        "No active Compose services to await; check service profiles and replica counts",
        EXIT_CODES.CONFIG_ERROR
      )
    }
    const result = await pollComposeReadiness(
      expected,
      () => {
        try {
          const names = new Set(expected.map((service) => service.name))
          const rows = parseComposePs(
            runDocker([...args, "ps", "--all", "--format", "json"])
          ).filter((row) => names.has(row.service))
          // `compose ps --all` also includes `compose run` one-offs. A completed
          // maintenance shell must not count as a missing/unhealthy service replica.
          const ids = [...new Set(rows.map((row) => row.id).filter(Boolean))]
          const oneOffs = new Set<string>()
          if (ids.length > 0) {
            const labels = runDocker(["inspect", "--format", "{{json .Config.Labels}}", ...ids])
              .split(/\r?\n/)
              .filter(Boolean)
            if (labels.length !== ids.length) throw new Error("Incomplete container label response")
            for (let index = 0; index < ids.length; index++) {
              const value: unknown = JSON.parse(labels[index])
              if (!value || typeof value !== "object" || Array.isArray(value)) {
                throw new Error("Cannot inspect Compose container labels")
              }
              const oneOff = (value as Record<string, unknown>)["com.docker.compose.oneoff"]
              if (
                oneOff === true ||
                (typeof oneOff === "string" && oneOff.toLowerCase() === "true")
              )
                oneOffs.add(ids[index])
            }
          }
          const containers = rows.filter((row) => !oneOffs.has(row.id))
          services = evaluateReadiness(expected, containers)
          return containers
        } catch (error) {
          if (error instanceof CLIError) throw error
          throw new CLIError(
            `Invalid Compose ps response: ${getErrorMessage(error)}`,
            EXIT_CODES.DOCKER_ERROR
          )
        }
      },
      deadline
    )
    services = result.services
    return {
      branch: context.targetBranch,
      path: context.worktreePath,
      project: context.targetProject,
      composeFile: context.composePath,
      elapsedMs: Date.now() - started,
      ...result,
    }
  } catch (error) {
    if (context && Date.now() >= deadline) {
      return {
        branch: context.targetBranch,
        path: context.worktreePath,
        project: context.targetProject,
        composeFile: context.composePath,
        ok: false,
        timedOut: true,
        elapsedMs: Date.now() - started,
        services,
      }
    }
    if (Date.now() >= deadline)
      throw new CLIError("Timed out checking Compose ownership", EXIT_CODES.GENERAL_ERROR)
    if (error instanceof DockerComposeProjectInspectionError) {
      throw new CLIError(getErrorMessage(error), EXIT_CODES.DOCKER_ERROR)
    }
    throw error
  }
}

export function awaitCommand(): Command {
  return new Command("await")
    .description("Wait until this worktree's Compose services are ready")
    .argument("[branch]", "Worktree branch (default: current worktree)")
    .option("--timeout <seconds>", "Maximum wait in seconds", parseAwaitTimeout, 120)
    .option("--json", "Output machine-readable readiness state")
    .action(async (branch: string | undefined, options: { timeout: number; json?: boolean }) => {
      try {
        const result = await waitForWorktree(branch, options)
        if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        else if (result.ok)
          process.stdout.write(`Compose services are ready for ${result.branch}\n`)
        else
          process.stderr.write(
            `Timed out waiting for Compose services: ${result.services
              .filter((service) => !service.ready)
              .map((service) => service.service)
              .join(", ")}\n`
          )
        if (!result.ok) process.exitCode = EXIT_CODES.GENERAL_ERROR
      } catch (error) {
        const message = getErrorMessage(error)
        if (options.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
        process.stderr.write(`Error: ${message}\n`)
        process.exitCode = error instanceof CLIError ? error.exitCode : EXIT_CODES.GENERAL_ERROR
      }
    })
}
