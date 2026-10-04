import { Command } from "commander"
import { CLIError, getErrorMessage } from "../../utils/error.js"
import { withErrorHandling } from "../utils/command-helpers.js"
import {
  installOrcaHooks,
  orcaHookCommands,
  type OrcaInstallOptions,
} from "../utils/orca-install.js"

interface InitOrcaOptions extends OrcaInstallOptions {
  json?: boolean
}

export function initOrcaCommand(): Command {
  return new Command("init-orca")
    .description("Install wtb setup and archive hooks in the repository's orca.yaml")
    .option("--remove-volumes", "Configure archive to delete only this worktree's owned volumes")
    .option("-f, --force", "Replace conflicting wtb hook keys; preserve unrelated configuration")
    .option("--check", "Check hook configuration without writing; exit 1 when it differs")
    .option("--dry-run", "Preview the integration keys without writing")
    .option("--json", "Print one JSON result, including errors")
    .action(withErrorHandling(executeInitOrcaCommand))
}

export async function executeInitOrcaCommand(options: InitOrcaOptions): Promise<void> {
  try {
    const result = await installOrcaHooks(options)
    if (options.json) console.log(JSON.stringify(result, null, 2))
    else {
      console.log(
        `${result.check ? (result.ok ? "Up to date" : "Needs update") : result.dryRun ? "Dry run" : result.wrote ? "Installed" : "Up to date"}: ${result.path}`
      )
      if (result.dryRun) {
        for (const [key, value] of Object.entries(orcaHookCommands(options.removeVolumes))) {
          console.log(`  ${key}: ${value}`)
        }
      }
      if (!result.check) {
        console.log(
          "In Orca, enable shared repository hooks and run setup by default. CLI deletion needs --run-hooks."
        )
      }
    }
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    const failure = error instanceof CLIError ? error : new CLIError(getErrorMessage(error), 1)
    if (!options.json) throw failure
    console.log(
      JSON.stringify({ ok: false, error: failure.message, exitCode: failure.exitCode }, null, 2)
    )
    process.exitCode = failure.exitCode
  }
}
