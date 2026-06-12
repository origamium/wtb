/**
 * @fileoverview init-claude コマンドのテスト
 *
 * `--check` 契約: インストール済み SKILL.md が最新なら exit 0、
 * stale / stamp なし / 未インストールなら GENERAL_ERROR で非ゼロ終了する。
 * skip 経路の stale 通知 (skippedReason) の表示も検証する。
 */

import type { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EXIT_CODES } from "../../constants/index.js"
import * as skillInstallModule from "../utils/claude-skill-install.js"
import { initClaudeCommand } from "./init-claude.js"

vi.mock("../utils/claude-skill-install.js")

describe("init-claude command", () => {
  let command: Command
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited")
    })
    command = initClaudeCommand()
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    exitSpy.mockRestore()
  })

  function stdoutText(): string {
    return consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n")
  }

  function stderrText(): string {
    return consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
  }

  it("prints the stale skippedReason when the skip path detects version drift", async () => {
    vi.mocked(skillInstallModule.installClaudeSkill).mockResolvedValue({
      targetDir: "/repo/.claude/skills/wtb",
      skillPath: "/repo/.claude/skills/wtb/SKILL.md",
      existed: true,
      wrote: false,
      skippedReason: "stale (installed v0.0.1, bundled v9.9.9) — re-run with --force",
    })

    await command.parseAsync([], { from: "user" })

    expect(stdoutText()).toContain("stale (installed v0.0.1, bundled v9.9.9) — re-run with --force")
    expect(exitSpy).not.toHaveBeenCalled()
  })

  describe("--check", () => {
    it("exits 0 and reports up to date when the installed skill matches the CLI", async () => {
      vi.mocked(skillInstallModule.checkClaudeSkill).mockReturnValue({
        skillPath: "/repo/.claude/skills/wtb/SKILL.md",
        installed: true,
        installedVersion: "9.9.9",
        bundledVersion: "9.9.9",
        stale: false,
      })

      await command.parseAsync(["--check"], { from: "user" })

      expect(skillInstallModule.checkClaudeSkill).toHaveBeenCalledWith({ user: undefined })
      expect(skillInstallModule.installClaudeSkill).not.toHaveBeenCalled()
      expect(stdoutText()).toContain("up to date (v9.9.9)")
      expect(exitSpy).not.toHaveBeenCalled()
    })

    it("exits non-zero when the installed skill is stale", async () => {
      vi.mocked(skillInstallModule.checkClaudeSkill).mockReturnValue({
        skillPath: "/repo/.claude/skills/wtb/SKILL.md",
        installed: true,
        installedVersion: "0.0.1",
        bundledVersion: "9.9.9",
        stale: true,
      })

      await expect(command.parseAsync(["--check"], { from: "user" })).rejects.toThrow("exited")

      expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
      expect(stderrText()).toContain("stale (installed v0.0.1, bundled v9.9.9)")
      expect(stderrText()).toContain("--force")
    })

    it("exits non-zero and says 'unstamped' when the installed skill has no version stamp", async () => {
      vi.mocked(skillInstallModule.checkClaudeSkill).mockReturnValue({
        skillPath: "/repo/.claude/skills/wtb/SKILL.md",
        installed: true,
        installedVersion: null,
        bundledVersion: "9.9.9",
        stale: true,
      })

      await expect(command.parseAsync(["--check"], { from: "user" })).rejects.toThrow("exited")

      expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
      expect(stderrText()).toContain("stale (installed unstamped, bundled v9.9.9)")
    })

    it("exits non-zero when the skill is not installed", async () => {
      vi.mocked(skillInstallModule.checkClaudeSkill).mockReturnValue({
        skillPath: "/repo/.claude/skills/wtb/SKILL.md",
        installed: false,
        installedVersion: null,
        bundledVersion: "9.9.9",
        stale: true,
      })

      await expect(command.parseAsync(["--check"], { from: "user" })).rejects.toThrow("exited")

      expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
      expect(stderrText()).toContain("not installed")
    })

    it("passes --user through to checkClaudeSkill", async () => {
      vi.mocked(skillInstallModule.checkClaudeSkill).mockReturnValue({
        skillPath: "/home/u/.claude/skills/wtb/SKILL.md",
        installed: true,
        installedVersion: "9.9.9",
        bundledVersion: "9.9.9",
        stale: false,
      })

      await command.parseAsync(["--check", "--user"], { from: "user" })

      expect(skillInstallModule.checkClaudeSkill).toHaveBeenCalledWith({ user: true })
    })
  })
})
