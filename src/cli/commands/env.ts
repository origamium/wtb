import { Command } from "commander"
import { EXIT_CODES } from "../../constants/index.js"
import { loadConfig } from "../../core/config/loader.js"
import { buildWorktreeEnvMap } from "../../core/environment/env-map.js"
import { getRepositoryContext } from "../../core/git/repository.js"
import type { WtbConfig } from "../../types/index.js"
import { CLIError } from "../../utils/error.js"
import { resolveWorktreeTarget, withErrorHandling } from "../utils/command-helpers.js"

export function adjustedEnvironment(path: string, config: WtbConfig): Record<string, string> {
  const values = buildWorktreeEnvMap(path, config)
  const entries = Object.keys(config.env.adjust)
    .filter((key) => config.env.adjust[key] !== null && Object.hasOwn(values, key))
    .map((key) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new CLIError(
          `Cannot render invalid shell variable name '${key}'`,
          EXIT_CODES.CONFIG_ERROR
        )
      }
      if (values[key].includes("\0")) {
        throw new CLIError(
          `Environment value for '${key}' contains a NUL byte`,
          EXIT_CODES.CONFIG_ERROR
        )
      }
      return [key, values[key]]
    })
  return Object.fromEntries(entries)
}

/** POSIX shell assignments: quotes, substitutions, whitespace and newlines remain data. */
export function renderEnvironment(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}='${value.replace(/'/g, "'\\''")}'\n`)
    .join("")
}

export function envCommand(): Command {
  return new Command("env")
    .description("Print adjusted environment values as safe POSIX shell assignments")
    .argument("[branch]", "Worktree branch (default: current worktree)")
    .option("--json", "Output a JSON object instead of shell assignments")
    .action(
      withErrorHandling(async (branch: string | undefined, options: { json?: boolean }) => {
        const { mainRoot } = getRepositoryContext()
        const { worktreePath } = resolveWorktreeTarget("env", branch)
        const values = adjustedEnvironment(worktreePath, loadConfig(mainRoot))
        process.stdout.write(
          options.json ? `${JSON.stringify(values, null, 2)}\n` : renderEnvironment(values)
        )
      })
    )
}
