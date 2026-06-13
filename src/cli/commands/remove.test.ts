/**
 * @fileoverview remove コマンドのユニットテスト
 *
 * 破壊的処理の順序ガードを最優先で検証する:
 * - dirty worktree は volume 削除 (docker compose down) より前に fail fast すること
 * - 設定された docker_compose_file が `-f` で明示的に渡されること
 * - unknown branch のエラー診断が stdout を汚さないこと
 */

import * as path from "node:path"
import type { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EXIT_CODES } from "../../constants/index.js"
import * as loaderModule from "../../core/config/loader.js"
import * as repositoryModule from "../../core/git/repository.js"
import * as worktreeModule from "../../core/git/worktree.js"
import * as execModule from "../../utils/exec.js"
import { removeCommand } from "./remove.js"

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}))
vi.mock("../../core/config/loader.js")
vi.mock("../../core/git/repository.js")
vi.mock("../../core/git/worktree.js")
vi.mock("../../utils/exec.js")

const WORKTREE_PATH = "/wt/worktree-feature"

describe("remove command", () => {
  let command: Command
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    command = removeCommand()
    vi.mocked(repositoryModule.getGitRootOrThrow).mockReturnValue("/repo")
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue(WORKTREE_PATH)
    vi.mocked(worktreeModule.isSamePath).mockReturnValue(false)
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([])
    // B1: manifest 既定は空 (managed ファイルなし)。dirty チェックは素の git status に従う。
    vi.mocked(worktreeModule.loadWtbManagedManifest).mockReturnValue({})
    vi.mocked(worktreeModule.gitHashObject).mockReturnValue(null)
    vi.mocked(loaderModule.loadConfig).mockReturnValue({
      base_branch: "main",
      docker_compose_file: "compose.dev.yml",
      copy_files: [],
      link_files: [],
      env: { file: [], adjust: {} },
      volumes: { exclude: [] },
    })
    // git status --porcelain → clean by default
    vi.mocked(execModule.execGitSafe).mockReturnValue("")
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it("fails fast on a dirty worktree BEFORE any Docker teardown or volume deletion", async () => {
    vi.mocked(execModule.execGitSafe).mockReturnValue("M src/app.ts")
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await expect(
      command.parseAsync(["feature/x", "--remove-volumes"], { from: "user" })
    ).rejects.toThrow("exit")

    expect(exit).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
    expect(execModule.execGitSafe).toHaveBeenCalledWith(["status", "--porcelain"], {
      cwd: WORKTREE_PATH,
    })
    // 破壊的処理は一切走らないこと
    expect(execModule.execDockerSafe).not.toHaveBeenCalled()
    expect(worktreeModule.removeWorktree).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("uncommitted or untracked"))
    exit.mockRestore()
  })

  it("skips the dirty check with -f and forwards force to git", async () => {
    await command.parseAsync(["feature/x", "-f"], { from: "user" })

    expect(execModule.execGitSafe).not.toHaveBeenCalled()
    expect(worktreeModule.removeWorktree).toHaveBeenCalledWith(WORKTREE_PATH, { force: true })
  })

  it("passes the configured compose file via 'docker compose -f <path> down'", async () => {
    await command.parseAsync(["feature/x"], { from: "user" })

    expect(execModule.execDockerSafe).toHaveBeenCalledWith(
      ["compose", "-f", path.resolve(WORKTREE_PATH, "compose.dev.yml"), "down"],
      { cwd: WORKTREE_PATH }
    )
    // manifest が空 (managed ファイルなし) かつ clean なので force は不要 (false)。
    expect(worktreeModule.removeWorktree).toHaveBeenCalledWith(WORKTREE_PATH, {
      force: false,
    })
  })

  it("appends -v with --remove-volumes", async () => {
    await command.parseAsync(["feature/x", "--remove-volumes"], { from: "user" })

    expect(execModule.execDockerSafe).toHaveBeenCalledWith(
      ["compose", "-f", path.resolve(WORKTREE_PATH, "compose.dev.yml"), "down", "-v"],
      { cwd: WORKTREE_PATH }
    )
  })

  it("B1: ignores a managed file that still equals wtb's output and force-removes the worktree", async () => {
    // manifest に compose.dev.yml: "sha-wtb" を記録。git status はその 1 ファイルだけ
    // modified を返すが、hash-object が同じ sha を返す = wtb の出力そのまま → not dirty。
    vi.mocked(worktreeModule.loadWtbManagedManifest).mockReturnValue({
      "compose.dev.yml": "sha-wtb",
    })
    vi.mocked(worktreeModule.gitHashObject).mockReturnValue("sha-wtb")
    vi.mocked(execModule.execGitSafe).mockReturnValue(" M compose.dev.yml")

    await command.parseAsync(["feature/x"], { from: "user" })

    // managed ファイルの skip-worktree を一旦解除して真の状態を surface させる。
    expect(worktreeModule.clearSkipWorktree).toHaveBeenCalledWith(WORKTREE_PATH, "compose.dev.yml")
    // dirty 判定を通過し、managed 書き換えが残るため最終削除は force される。
    expect(worktreeModule.removeWorktree).toHaveBeenCalledWith(WORKTREE_PATH, { force: true })
  })

  it("B1: BLOCKS when a managed file diverges from wtb's recorded output (user edit)", async () => {
    vi.mocked(worktreeModule.loadWtbManagedManifest).mockReturnValue({
      "compose.dev.yml": "sha-wtb",
    })
    // 現在の sha が manifest と異なる = ユーザーが手編集した → really dirty。
    vi.mocked(worktreeModule.gitHashObject).mockReturnValue("sha-user-edited")
    vi.mocked(execModule.execGitSafe).mockReturnValue(" M compose.dev.yml")
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await expect(command.parseAsync(["feature/x"], { from: "user" })).rejects.toThrow("exit")

    expect(exit).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
    expect(worktreeModule.removeWorktree).not.toHaveBeenCalled()
    expect(execModule.execDockerSafe).not.toHaveBeenCalled()
    exit.mockRestore()
  })

  it("prints the worktree listing to stderr (not stdout) for an unknown branch", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue(null)
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/repo", branch: "main", head: "a" },
    ])
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await expect(command.parseAsync(["nope"], { from: "user" })).rejects.toThrow("exit")

    expect(exit).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
    expect(errorSpy).toHaveBeenCalledWith("Available worktrees:")
    expect(errorSpy).toHaveBeenCalledWith("  main: /repo")
    expect(logSpy).not.toHaveBeenCalled()
    exit.mockRestore()
  })
})
