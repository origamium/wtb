/**
 * @fileoverview `wtb init` コマンド実装
 * コメント付きの wtb.yaml テンプレートをリポジトリルートに生成する
 */

import { Command } from "commander"
import { EXIT_CODES } from "../../constants/index.js"
import {
  createDefaultConfig,
  findConfigFile,
  getConfigFilePath,
  hasConfigFile,
} from "../../core/config/loader.js"
import { getMainWorktreeRoot } from "../../core/git/repository.js"
import { CLIError } from "../../utils/error.js"
import { execGitSafe } from "../../utils/exec.js"
import { withErrorHandling } from "../utils/command-helpers.js"

interface InitOptions {
  force?: boolean
}

/**
 * initコマンドを作成
 */
export function initCommand(): Command {
  return new Command("init")
    .description("Scaffold a commented wtb.yaml config file in the repository root")
    .option("-f, --force", "Overwrite an existing wtb.yaml")
    .action(withErrorHandling(executeInitCommand))
}

/**
 * origin/HEAD からリポジトリのデフォルトブランチを検出する。
 * origin/HEAD 未設定 (fresh clone / remote 無し) の場合は黙って "main" にフォールバック。
 */
export function detectDefaultBranch(cwd?: string): string {
  try {
    // 例: "refs/remotes/origin/main" → "main"
    const ref = execGitSafe(["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd })
    const branch = ref.replace(/^refs\/remotes\/origin\//, "").trim()
    return branch || "main"
  } catch {
    return "main"
  }
}

async function executeInitCommand(options: InitOptions): Promise<void> {
  const gitRoot = getMainWorktreeRoot()

  if (hasConfigFile(gitRoot) && options.force !== true) {
    const existing = findConfigFile(gitRoot).path
    throw new CLIError(
      `Config file already exists: ${existing}. Use --force to overwrite it.`,
      EXIT_CODES.GENERAL_ERROR
    )
  }

  const baseBranch = detectDefaultBranch(gitRoot)
  const targetPath = getConfigFilePath(gitRoot)
  createDefaultConfig(targetPath, { base_branch: baseBranch })

  console.log(`✅ Created ${targetPath}`)
  console.log(`   base_branch: ${baseBranch}`)
  console.log("")
  console.log("Next step: edit the generated file —")
  console.log("  - set docker_compose_file if this project uses Docker Compose")
  console.log("  - list your .env files under env.file and mark port variables in env.adjust")
  console.log("  - add gitignored files (e.g. .env) to copy_files")
}
