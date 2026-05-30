#!/usr/bin/env node

/**
 * @fileoverview wtb CLI メインエントリーポイント
 * コマンドライン引数の解析とコマンド実行を担当
 */

import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Command } from "commander"
import { APP_DESCRIPTION, APP_NAME, APP_VERSION, EXIT_CODES } from "../constants/index.js"
import { createCommand } from "./commands/create.js"
import { initClaudeCommand } from "./commands/init-claude.js"
import { lsCommand } from "./commands/ls.js"
import { portsCommand } from "./commands/ports.js"
import { pruneCommand } from "./commands/prune.js"
import { recloneCommand } from "./commands/reclone.js"
import { removeCommand } from "./commands/remove.js"
import { statusCommand } from "./commands/status.js"

/**
 * メインCLIプログラムを作成・設定
 */
function createMainProgram(): Command {
  const program = new Command()

  program.name(APP_NAME).description(APP_DESCRIPTION).version(APP_VERSION)

  // サブコマンド追加
  program.addCommand(statusCommand())
  program.addCommand(lsCommand())
  program.addCommand(portsCommand())
  program.addCommand(createCommand())
  program.addCommand(removeCommand())
  program.addCommand(recloneCommand())
  program.addCommand(pruneCommand())
  program.addCommand(initClaudeCommand())

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
  const gracefulExit = () => {
    console.log("\n👋 Goodbye!")
    process.exit(EXIT_CODES.SUCCESS)
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

export { createMainProgram, main }
