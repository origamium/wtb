/**
 * @fileoverview `wtb doctor` コマンド実装
 */
import { existsSync } from "node:fs"
import * as path from "node:path"
import { Command } from "commander"
import { EXIT_CODES } from "../../constants/index.js"
import { loadConfig } from "../../core/config/loader.js"
import { readComposeFile } from "../../core/docker/compose.js"
import { resolveComposePath } from "../../core/docker/locate.js"
import { type AnalyzeOptions, analyzeRelocatability } from "../../core/docker/relocatability.js"
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

/**
 * doctor の finding 降格判定に使う options を、create の実挙動と一致させて構築する。
 * 重要: docker_compose_file が未設定なら create の compose フェーズは丸ごとスキップされる
 * ので、compose を自動検出できても identity/ポートの書き換えは走らない → 各フラグは false。
 */
function buildAnalyzeOptions(config: WtbConfig): AnalyzeOptions {
  const composeConfigured = !!config.docker_compose_file
  const isolate = config.compose?.isolate_name ?? true
  const containerMode = config.compose?.container_name ?? "suffix"
  const propEnabled = config.env.port_propagation?.enabled ?? true
  const propCompose = config.env.port_propagation?.compose ?? true
  return {
    identityRewriteEnabled: isolate && composeConfigured,
    containerNameRewriteEnabled: containerMode !== "keep" && composeConfigured,
    composePortPropagationEnabled: propEnabled && propCompose && composeConfigured,
    envPortPropagationEnabled: propEnabled,
  }
}

/**
 * compose ファイルに隣接し docker が自動マージする override ファイルを列挙する。
 * override の auto-merge はデフォルト名の compose にのみ効くので、その組み合わせに限定して
 * 偽陽性を避ける。
 */
function discoverOverrideFiles(composePath: string | null): string[] {
  if (!composePath) return []
  const dir = path.dirname(composePath)
  const base = path.basename(composePath)
  const overrideMap: Record<string, string[]> = {
    "docker-compose.yml": ["docker-compose.override.yml", "docker-compose.override.yaml"],
    "docker-compose.yaml": ["docker-compose.override.yml", "docker-compose.override.yaml"],
    "compose.yml": ["compose.override.yml", "compose.override.yaml"],
    "compose.yaml": ["compose.override.yml", "compose.override.yaml"],
  }
  return (overrideMap[base] ?? []).filter((c) => existsSync(path.join(dir, c)))
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
    options: buildAnalyzeOptions(config),
    overrideFiles: discoverOverrideFiles(composePath),
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
      options: buildAnalyzeOptions(config),
      overrideFiles: discoverOverrideFiles(composePath),
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
