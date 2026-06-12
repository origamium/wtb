/**
 * @fileoverview create コマンドのブランチ解決ロジックのユニットテスト
 *
 * remote-only ブランチ (teammate が push 済みでローカルには無い) を base_branch から
 * 新規作成して黙って shadow せず、origin/<branch> からトラッキングブランチを
 * 作ることを検証する。重い phase (docker / volume / env) は config を空にして回避する。
 */

import type { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as loaderModule from "../../core/config/loader.js"
import * as repositoryModule from "../../core/git/repository.js"
import * as worktreeModule from "../../core/git/worktree.js"
import { createCommand } from "./create.js"

vi.mock("../../core/config/loader.js")
vi.mock("../../core/git/repository.js")
vi.mock("../../core/git/worktree.js")

describe("create command branch resolution", () => {
  let command: Command
  let logSpy: ReturnType<typeof vi.spyOn>
  const logged = () => logSpy.mock.calls.map((c) => c[0]).join("\n")

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    command = createCommand()
    vi.mocked(repositoryModule.getGitRootOrThrow).mockReturnValue("/repo")
    vi.mocked(repositoryModule.branchExists).mockReturnValue(false)
    vi.mocked(repositoryModule.remoteBranchExists).mockReturnValue(false)
    vi.mocked(repositoryModule.revisionExists).mockReturnValue(true)
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue(null)
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([])
    // docker_compose_file / copy_files / env を空にして worktree 作成 phase だけを通す
    vi.mocked(loaderModule.loadConfig).mockReturnValue({
      base_branch: "main",
      docker_compose_file: "",
      copy_files: [],
      link_files: [],
      env: { file: [], adjust: {} },
      volumes: { exclude: [] },
    })
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it("creates a tracking branch from origin/<branch> when the branch exists only on the remote", async () => {
    vi.mocked(repositoryModule.remoteBranchExists).mockReturnValue(true)

    await command.parseAsync(["feature/x"], { from: "user" })

    expect(worktreeModule.createWorktree).toHaveBeenCalledWith(
      "feature/x",
      expect.stringContaining("worktree-feature"),
      { useExistingBranch: false, baseBranch: undefined, trackFrom: "origin/feature/x" }
    )
    expect(logged()).toContain("exists on origin — creating local tracking branch")
  })

  it("creates a new branch off base_branch when the branch exists nowhere", async () => {
    await command.parseAsync(["feature/x"], { from: "user" })

    expect(worktreeModule.createWorktree).toHaveBeenCalledWith(
      "feature/x",
      expect.stringContaining("worktree-feature"),
      { useExistingBranch: false, baseBranch: "main", trackFrom: undefined }
    )
    expect(logged()).toContain("Creating new branch")
  })

  it("fails fast with an actionable error when base_branch does not resolve", async () => {
    vi.mocked(repositoryModule.revisionExists).mockReturnValue(false)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited")
    })

    await expect(command.parseAsync(["feature/x"], { from: "user" })).rejects.toThrow("exited")

    expect(repositoryModule.revisionExists).toHaveBeenCalledWith("main")
    expect(worktreeModule.createWorktree).not.toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("base_branch 'main' does not resolve in this repository")
    )
    errorSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it("skips the base_branch check when using an existing local branch", async () => {
    vi.mocked(repositoryModule.branchExists).mockReturnValue(true)
    vi.mocked(repositoryModule.revisionExists).mockReturnValue(false)

    await command.parseAsync(["feature/x"], { from: "user" })

    expect(repositoryModule.revisionExists).not.toHaveBeenCalled()
    expect(worktreeModule.createWorktree).toHaveBeenCalled()
  })

  it("uses the existing local branch without consulting the remote", async () => {
    vi.mocked(repositoryModule.branchExists).mockReturnValue(true)

    await command.parseAsync(["feature/x"], { from: "user" })

    expect(repositoryModule.remoteBranchExists).not.toHaveBeenCalled()
    expect(worktreeModule.createWorktree).toHaveBeenCalledWith(
      "feature/x",
      expect.stringContaining("worktree-feature"),
      { useExistingBranch: true, baseBranch: undefined, trackFrom: undefined }
    )
  })
})
