#!/usr/bin/env node

/**
 * @fileoverview wtb CLI メインエントリーポイント
 * コマンドライン引数の解析とコマンド実行を担当
 */

import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Command, type CommanderError } from "commander"
import { APP_DESCRIPTION, APP_NAME, APP_VERSION, EXIT_CODES } from "../constants/index.js"
import { createCommand } from "./commands/create.js"
import { doctorCommand } from "./commands/doctor.js"
import { initCommand } from "./commands/init.js"
import { initClaudeCommand } from "./commands/init-claude.js"
import { lsCommand } from "./commands/ls.js"
import { pathCommand } from "./commands/path.js"
import { portsCommand } from "./commands/ports.js"
import { pruneCommand } from "./commands/prune.js"
import { recloneCommand } from "./commands/reclone.js"
import { removeCommand } from "./commands/remove.js"
import { statusCommand } from "./commands/status.js"

/**
 * commander が使い方エラーとして報告する code の集合。
 * これらは README の exit-code 契約どおり INVALID_USAGE (2) で終了させる。
 */
const COMMANDER_USAGE_ERROR_CODES = new Set([
  "commander.missingArgument",
  "commander.unknownOption",
  "commander.unknownCommand",
  "commander.invalidArgument",
  "commander.excessArguments",
  "commander.conflictingOption",
])

/**
 * exitOverride 経由で受け取った CommanderError を wtb の exit code にマップする。
 * --help / --version (exitCode 0) はそのまま 0、使い方エラーは INVALID_USAGE (2)。
 */
function mapCommanderExitCode(error: CommanderError): number {
  if (error.exitCode === 0) {
    return error.exitCode // commander.helpDisplayed / commander.version
  }
  if (COMMANDER_USAGE_ERROR_CODES.has(error.code)) {
    return EXIT_CODES.INVALID_USAGE
  }
  return EXIT_CODES.GENERAL_ERROR
}

/**
 * メインCLIプログラムを作成・設定
 */
function createMainProgram(): Command {
  const program = new Command()

  program.name(APP_NAME).description(APP_DESCRIPTION).version(APP_VERSION)

  // サブコマンド追加
  program.addCommand(statusCommand())
  program.addCommand(lsCommand())
  program.addCommand(pathCommand())
  program.addCommand(portsCommand())
  program.addCommand(createCommand())
  program.addCommand(removeCommand())
  program.addCommand(recloneCommand())
  program.addCommand(pruneCommand())
  program.addCommand(initCommand())
  program.addCommand(initClaudeCommand())
  program.addCommand(doctorCommand())

  // 使い方エラー (引数不足など) を commander 既定の exit 1 ではなく INVALID_USAGE (2)
  // で終了させる。exitOverride は addCommand したサブコマンドへ自動伝播しないため、
  // 各サブコマンドにも同じコールバックを設定する。
  const exitWithMappedCode = (error: CommanderError): never => {
    process.exit(mapCommanderExitCode(error))
  }
  program.exitOverride(exitWithMappedCode)
  for (const subcommand of program.commands) {
    subcommand.exitOverride(exitWithMappedCode)
  }

  return program
}

/**
 * エラーハンドリングとプロセス終了の設定
 */
function setupErrorHandling(): void {
  process.on("uncaughtException", (error) => {
    console.error("💥 Uncaught Exception:", error.message)
    process.exit(EXIT_CODES.GENERAL_ERROR)
  })

  process.on("unhandledRejection", (reason, promise) => {
    console.error("💥 Unhandled Rejection at:", promise, "reason:", reason)
    process.exit(EXIT_CODES.GENERAL_ERROR)
  })

  // SIGINT (Ctrl-C) と SIGTERM (kill) の両方で同じ後始末経路を通す。
  // 長時間処理 (volume clone 中の stop-then-copy など) は、コマンド側が
  // process.prependListener でこれらのシグナルに復旧フック (source スタック
  // 再開) を差し込む。prepend なのでここの exit より先に必ず走る。
  // exit code は POSIX 慣習 (128 + signal number) に従い 130/143 を返す。
  // 中断された create は途中状態なので、SUCCESS (0) で覆い隠してはならない。
  // stderr に出す: --json モードの stdout 純度 (JSON 以外を流さない契約) を
  // 中断時にも守る。
  const gracefulExit = (signal: NodeJS.Signals) => {
    console.error("\n👋 Goodbye!")
    process.exit(signal === "SIGINT" ? 130 : 143)
  }
  process.on("SIGINT", gracefulExit)
  process.on("SIGTERM", gracefulExit)
}

/**
 * CLIアプリケーションのメイン実行関数
 */
function main(): void {
  setupErrorHandling()

  const program = createMainProgram()
  program.parse()
}

// スクリプトとして実行された場合のみmain()を呼び出し
// realpathSync resolves symlinks so npm-linked binaries work correctly
if (realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main()
}

export { createMainProgram, main, setupErrorHandling }
