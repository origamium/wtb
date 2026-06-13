/**
 * @fileoverview `wtb doctor` コマンド実装
 */
import { Command } from "commander"
import { EXIT_CODES } from "../../constants/index.js"
import { loadConfig } from "../../core/config/loader.js"
import { readComposeFile } from "../../core/docker/compose.js"
import { resolveComposePath } from "../../core/docker/locate.js"
import { analyzeRelocatability } from "../../core/docker/relocatability.js"
import { buildWorktreeEnvMap } from "../../core/environment/env-map.js"
import { getGitRootOrThrow } from "../../core/git/repository.js"
import type { DoctorCommandOptions, WtbConfig } from "../../types/index.js"
import { CLIError } from "../../utils/error.js"
import { setJsonOutputMode } from "../../utils/output.js"
import { withErrorHandling } from "../utils/command-helpers.js"
import { renderDoctorJson, renderDoctorPretty } from "../utils/doctor-render.js"

export function doctorCommand(): Command {
  return new Command("doctor")
    .description(
      "Static preflight: check the repo's compose/env files for worktree-relocatability problems"
    )
    .option("--json", "JSON output (machine-readable)")
    .option("--strict", "Exit with code 1 if any warning or error finding exists")
    .action(withErrorHandling(executeDoctorCommand))
}

async function executeDoctorCommand(options: DoctorCommandOptions): Promise<void> {
  if (options.json) {
    setJsonOutputMode(true)
  }

  const gitRoot = getGitRootOrThrow()
  const config = loadConfig(gitRoot)
  const envMap = buildWorktreeEnvMap(gitRoot, config)

  // Resolve compose path from the SOURCE repo (gitRoot)
  const composePath = resolveComposePath(gitRoot, gitRoot, config)

  let compose = null
  if (composePath) {
    try {
      compose = readComposeFile(composePath)
    } catch {
      // If docker_compose_file was explicitly set and unreadable → error
      if (config.docker_compose_file) {
        throw new CLIError(
          `Configured compose file '${config.docker_compose_file}' is not readable: ${composePath}`,
          EXIT_CODES.GENERAL_ERROR
        )
      }
      // Otherwise treat as no-compose-file (already null)
    }
  } else if (config.docker_compose_file) {
    // Explicitly configured but not found
    throw new CLIError(
      `Configured compose file '${config.docker_compose_file}' was not found`,
      EXIT_CODES.GENERAL_ERROR
    )
  }

  const report = analyzeRelocatability({
    compose,
    composeFile: composePath,
    envMap,
    config,
    options: {
      identityRewriteEnabled: config.compose?.isolate_name ?? false,
      portPropagationEnabled: config.env.port_propagation?.enabled ?? false,
    },
  })

  if (options.json) {
    process.stdout.write(`${renderDoctorJson(report)}\n`)
  } else {
    process.stdout.write(renderDoctorPretty(report))
  }

  if (options.strict && !report.ok) {
    process.exitCode = EXIT_CODES.GENERAL_ERROR
    return
  }
}

/**
 * Run relocatability preflight for create flow.
 * Prints ONLY warning/error findings to stderr.
 * Never throws — must not affect create's exit code.
 */
export function runRelocatabilityPreflight(gitRoot: string, config: WtbConfig): void {
  try {
    const envMap = buildWorktreeEnvMap(gitRoot, config)
    const composePath = resolveComposePath(gitRoot, gitRoot, config)
    let compose = null
    if (composePath) {
      try {
        compose = readComposeFile(composePath)
      } catch {
        // ignore compose read errors in preflight
      }
    }

    const report = analyzeRelocatability({
      compose,
      composeFile: composePath,
      envMap,
      config,
      options: {
        identityRewriteEnabled: config.compose?.isolate_name ?? false,
        portPropagationEnabled: config.env.port_propagation?.enabled ?? false,
      },
    })

    const actionableFindings = report.findings.filter(
      (f) => f.severity === "warning" || f.severity === "error"
    )
    if (actionableFindings.length > 0) {
      for (const f of actionableFindings) {
        const parts = [f.message]
        if (f.suggestion) parts.push(`(${f.suggestion})`)
        console.error(`⚠️  preflight: ${parts.join(" ")}`)
      }
      console.error("Run 'wtb doctor' for details.")
    }
  } catch {
    // Preflight must never throw
  }
}
