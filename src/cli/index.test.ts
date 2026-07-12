/**
 * @fileoverview CLI エントリーポイントの exit code 契約のテスト
 *
 * README の exit-code 表に従い、使い方エラー (引数不足 / 未知のオプション /
 * 未知のコマンド) は INVALID_USAGE (2)、--help / --version は 0 で終了することを
 * 検証する。exitOverride の配線 (サブコマンドへの伝播含む) のレグレッションガード。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EXIT_CODES } from "../constants/index.js"
import { createMainProgram, setupErrorHandling } from "./index.js"

describe("CLI exit codes (commander exitOverride)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })
    // commander は console ではなく process.stdout/stderr.write に直接書くので、
    // テスト出力を汚さないよう両方を黙らせる。
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    exitSpy.mockRestore()
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it("exits with INVALID_USAGE (2) when a subcommand is missing a required argument", () => {
    const program = createMainProgram()
    expect(() => program.parse(["remove"], { from: "user" })).toThrow("exit")
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.INVALID_USAGE)
  })

  it("emits one remove JSON contract object for a usage error", () => {
    const previousArgv = process.argv
    process.argv = [previousArgv[0], previousArgv[1], "remove", "--json"]
    const program = createMainProgram()
    try {
      expect(() => program.parse(["remove", "--json"], { from: "user" })).toThrow("exit")
      const jsonWrites = stdoutSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((value) => value.trim().startsWith("{"))
      expect(jsonWrites).toHaveLength(1)
      expect(JSON.parse(jsonWrites[0])).toMatchObject({
        branch: null,
        removed: false,
        composeDown: null,
        endCommand: null,
        ok: false,
      })
      expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.INVALID_USAGE)
    } finally {
      process.argv = previousArgv
    }
  })

  it("does not emit remove JSON when another command merely uses 'remove' as an argument", () => {
    const previousArgv = process.argv
    process.argv = [
      previousArgv[0],
      previousArgv[1],
      "create",
      "remove",
      "--json",
      "--bogus",
    ]
    const program = createMainProgram()
    try {
      expect(() =>
        program.parse(["create", "remove", "--json", "--bogus"], { from: "user" })
      ).toThrow("exit")
      expect(
        stdoutSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((value) => value.trim().startsWith("{"))
      ).toEqual([])
    } finally {
      process.argv = previousArgv
    }
  })

  it("does not treat --json after the option terminator as a remove option", () => {
    const previousArgv = process.argv
    process.argv = [previousArgv[0], previousArgv[1], "remove", "feature/x", "--", "--json"]
    const program = createMainProgram()
    try {
      expect(() =>
        program.parse(["remove", "feature/x", "--", "--json"], { from: "user" })
      ).toThrow("exit")
      expect(
        stdoutSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((value) => value.trim().startsWith("{"))
      ).toEqual([])
    } finally {
      process.argv = previousArgv
    }
  })

  it("exits with INVALID_USAGE (2) for an unknown option", () => {
    const program = createMainProgram()
    expect(() => program.parse(["--bogus-flag"], { from: "user" })).toThrow("exit")
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.INVALID_USAGE)
  })

  it("exits with INVALID_USAGE (2) for an unknown command", () => {
    const program = createMainProgram()
    expect(() => program.parse(["no-such-command"], { from: "user" })).toThrow("exit")
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.INVALID_USAGE)
  })

  it("exits with INVALID_USAGE (2) for conflicting options (ports --json --pretty)", () => {
    const program = createMainProgram()
    expect(() => program.parse(["ports", "--json", "--pretty"], { from: "user" })).toThrow("exit")
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.INVALID_USAGE)
  })

  it("keeps exit 0 for --version", () => {
    const program = createMainProgram()
    expect(() => program.parse(["--version"], { from: "user" })).toThrow("exit")
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it("keeps exit 0 for --help", () => {
    const program = createMainProgram()
    expect(() => program.parse(["--help"], { from: "user" })).toThrow("exit")
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it("keeps exit 0 for a subcommand's --help (exitOverride propagates to subcommands)", () => {
    const program = createMainProgram()
    expect(() => program.parse(["create", "--help"], { from: "user" })).toThrow("exit")
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})

describe("CLI signal handling", () => {
  it("exits 130 on SIGINT and 143 on SIGTERM (128 + signal number)", () => {
    // process.on をフックしてハンドラを横取りし、実プロセスにリスナーを残さない。
    const handlers: Record<string, (signal: NodeJS.Signals) => void> = {}
    const onSpy = vi.spyOn(process, "on").mockImplementation(((
      event: string,
      handler: (signal: NodeJS.Signals) => void
    ) => {
      handlers[event] = handler
      return process
    }) as never)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    setupErrorHandling()
    onSpy.mockRestore()

    expect(() => handlers.SIGINT("SIGINT")).toThrow("exit")
    expect(exitSpy).toHaveBeenLastCalledWith(130)

    expect(() => handlers.SIGTERM("SIGTERM")).toThrow("exit")
    expect(exitSpy).toHaveBeenLastCalledWith(143)

    exitSpy.mockRestore()
    logSpy.mockRestore()
  })
})
