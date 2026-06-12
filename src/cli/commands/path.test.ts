/**
 * @fileoverview path コマンドのテスト
 *
 * `cd "$(wtb path <branch>)"` 契約: 見つかれば絶対パスを 1 行だけ stdout に出力、
 * 見つからなければ stderr に一覧を出して非ゼロ終了 (stdout は汚さない)。
 */

import type { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EXIT_CODES } from "../../constants/index.js"
import * as repositoryModule from "../../core/git/repository.js"
import * as worktreeModule from "../../core/git/worktree.js"
import { CLIError } from "../../utils/error.js"
import { pathCommand } from "./path.js"

vi.mock("../../core/git/repository.js")
vi.mock("../../core/git/worktree.js")

describe("path command", () => {
  let command: Command
  let writeSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    command = pathCommand()

    vi.mocked(repositoryModule.getGitRootOrThrow).mockReturnValue("/repo")
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/repo-feature")
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/repo", branch: "main", head: "abc" },
      { path: "/repo-feature", branch: "feature/x", head: "def" },
    ])
  })

  afterEach(() => {
    writeSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it("has name 'path' and a required <branch> argument", () => {
    expect(command.name()).toBe("path")
    expect(command.registeredArguments.map((a) => a.name())).toEqual(["branch"])
    expect(command.registeredArguments[0].required).toBe(true)
  })

  it("prints the worktree's absolute path, newline-terminated, with no decoration", async () => {
    await command.parseAsync(["feature/x"], { from: "user" })

    expect(worktreeModule.getWorktreePath).toHaveBeenCalledWith("feature/x")
    const output = writeSpy.mock.calls.map((c) => c[0]).join("")
    expect(output).toBe("/repo-feature\n")
  })

  it("exits GENERAL_ERROR and lists worktrees on stderr when the branch has no worktree", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue(null)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited")
    })

    await expect(command.parseAsync(["nope"], { from: "user" })).rejects.toThrow("exited")

    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
    // stdout は cd "$(...)" 用に空のまま
    expect(writeSpy).not.toHaveBeenCalled()
    const stderr = consoleErrorSpy.mock.calls.map((c) => c[0]).join("\n")
    expect(stderr).toContain("Available worktrees:")
    expect(stderr).toContain("feature/x: /repo-feature")
    expect(stderr).toContain("Worktree not found for branch: nope")
    exitSpy.mockRestore()
  })

  it("exits NOT_GIT_REPOSITORY when outside a git repo", async () => {
    vi.mocked(repositoryModule.getGitRootOrThrow).mockImplementation(() => {
      throw new CLIError("Not in a git repository", EXIT_CODES.NOT_GIT_REPOSITORY)
    })
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited")
    })

    await expect(command.parseAsync(["feature/x"], { from: "user" })).rejects.toThrow("exited")
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.NOT_GIT_REPOSITORY)
    exitSpy.mockRestore()
  })
})
