/**
 * @fileoverview init コマンドのテスト
 *
 * wtb.yaml の scaffold: 既存 config を --force なしで上書きしないこと、
 * origin/HEAD からのデフォルトブランチ検出と "main" フォールバックを検証する。
 */

import type { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EXIT_CODES } from "../../constants/index.js"
import * as loaderModule from "../../core/config/loader.js"
import * as repositoryModule from "../../core/git/repository.js"
import { CLIError } from "../../utils/error.js"
import * as execModule from "../../utils/exec.js"
import { detectDefaultBranch, initCommand } from "./init.js"

vi.mock("../../core/config/loader.js")
vi.mock("../../core/git/repository.js")
vi.mock("../../utils/exec.js")

describe("init command", () => {
  let command: Command
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    command = initCommand()

    vi.mocked(repositoryModule.getGitRootOrThrow).mockReturnValue("/repo")
    vi.mocked(loaderModule.hasConfigFile).mockReturnValue(false)
    vi.mocked(loaderModule.getConfigFilePath).mockReturnValue("/repo/wtb.yaml")
    vi.mocked(loaderModule.findConfigFile).mockReturnValue({
      path: "/repo/wtb.yaml",
      exists: true,
    })
    // origin/HEAD が未設定のケースをデフォルトにする (fresh clone 相当)
    vi.mocked(execModule.execGitSafe).mockImplementation(() => {
      throw new Error("ref refs/remotes/origin/HEAD is not a symbolic ref")
    })
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it("has name 'init' and exposes -f, --force", () => {
    expect(command.name()).toBe("init")
    const flags = command.options.map((o) => o.flags)
    expect(flags).toContain("-f, --force")
  })

  it("scaffolds wtb.yaml with base_branch 'main' when origin/HEAD is unset", async () => {
    await command.parseAsync([], { from: "user" })

    expect(loaderModule.createDefaultConfig).toHaveBeenCalledWith("/repo/wtb.yaml", {
      base_branch: "main",
    })
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("/repo/wtb.yaml"))
  })

  it("detects the default branch from origin/HEAD", async () => {
    vi.mocked(execModule.execGitSafe).mockReturnValue("refs/remotes/origin/develop")

    await command.parseAsync([], { from: "user" })

    expect(execModule.execGitSafe).toHaveBeenCalledWith(
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      { cwd: "/repo" }
    )
    expect(loaderModule.createDefaultConfig).toHaveBeenCalledWith("/repo/wtb.yaml", {
      base_branch: "develop",
    })
  })

  it("refuses to overwrite an existing config without --force", async () => {
    vi.mocked(loaderModule.hasConfigFile).mockReturnValue(true)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited")
    })

    await expect(command.parseAsync([], { from: "user" })).rejects.toThrow("exited")

    expect(loaderModule.createDefaultConfig).not.toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--force"))
    exitSpy.mockRestore()
  })

  it("overwrites an existing config with --force", async () => {
    vi.mocked(loaderModule.hasConfigFile).mockReturnValue(true)

    await command.parseAsync(["--force"], { from: "user" })

    expect(loaderModule.createDefaultConfig).toHaveBeenCalledWith("/repo/wtb.yaml", {
      base_branch: "main",
    })
  })

  it("exits NOT_GIT_REPOSITORY when outside a git repo", async () => {
    vi.mocked(repositoryModule.getGitRootOrThrow).mockImplementation(() => {
      throw new CLIError("Not in a git repository", EXIT_CODES.NOT_GIT_REPOSITORY)
    })
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited")
    })

    await expect(command.parseAsync([], { from: "user" })).rejects.toThrow("exited")
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.NOT_GIT_REPOSITORY)
    exitSpy.mockRestore()
  })
})

describe("detectDefaultBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("strips the refs/remotes/origin/ prefix", () => {
    vi.mocked(execModule.execGitSafe).mockReturnValue("refs/remotes/origin/master")
    expect(detectDefaultBranch("/repo")).toBe("master")
  })

  it("falls back to 'main' when git fails", () => {
    vi.mocked(execModule.execGitSafe).mockImplementation(() => {
      throw new Error("not a symbolic ref")
    })
    expect(detectDefaultBranch("/repo")).toBe("main")
  })

  it("falls back to 'main' on an empty result", () => {
    vi.mocked(execModule.execGitSafe).mockReturnValue("")
    expect(detectDefaultBranch("/repo")).toBe("main")
  })
})
