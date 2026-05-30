/**
 * @fileoverview reclone コマンドのユニットテスト
 * 対象 worktree の解決とガード (unknown branch / main worktree / no docker) を検証する。
 * 実際の volume コピーは setupVolumeCopy 側のテストでカバー済みなのでここでは mock する。
 */

import type { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EXIT_CODES } from "../../constants/index.js"
import * as loaderModule from "../../core/config/loader.js"
import * as repositoryModule from "../../core/git/repository.js"
import * as worktreeModule from "../../core/git/worktree.js"
import * as createModule from "./create.js"
import { recloneCommand } from "./reclone.js"

vi.mock("../../core/config/loader.js")
vi.mock("../../core/git/repository.js")
vi.mock("../../core/git/worktree.js")
vi.mock("./create.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./create.js")>()
  return {
    ...actual,
    setupVolumeCopy: vi.fn(),
    previewVolumeCopy: vi.fn(),
  }
})

describe("reclone command", () => {
  let command: Command
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    command = recloneCommand()
    vi.mocked(repositoryModule.getGitRootOrThrow).mockReturnValue("/project")
    vi.mocked(loaderModule.loadConfig).mockReturnValue({
      base_branch: "main",
      docker_compose_file: "./docker-compose.yml",
      copy_files: [],
      link_files: [],
      env: { file: [], adjust: {} },
      volumes: { exclude: [] },
    })
    vi.mocked(createModule.setupVolumeCopy).mockResolvedValue({ copied: 1, skipped: 0, failed: 0 })
    // 既定では「別パス」(main repo ではない) として扱う。main repo ガードのテストだけ true に上書きする。
    // clearAllMocks は実装(mockReturnValue)をリセットしないため、ここで明示的に既定値を設定する。
    vi.mocked(worktreeModule.isSamePath).mockReturnValue(false)
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it("has the expected name and flags", () => {
    expect(command.name()).toBe("reclone")
    const flags = command.options.map((o) => o.flags)
    expect(flags).toContain("--force-volume-copy")
    expect(flags).toContain("--no-stop")
    expect(flags).toContain("--dry-run")
  })

  it("re-clones the named worktree via setupVolumeCopy", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/project-feature")

    await command.parseAsync(["feature/x"], { from: "user" })

    expect(createModule.setupVolumeCopy).toHaveBeenCalledWith(
      "/project",
      "/project-feature",
      expect.anything(),
      expect.objectContaining({ force: false })
    )
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("✅ Reclone complete"))
  })

  it("fails with exit 1 for an unknown branch", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue(null)
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([])
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await expect(command.parseAsync(["nope"], { from: "user" })).rejects.toThrow("exit")
    expect(exit).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
    expect(createModule.setupVolumeCopy).not.toHaveBeenCalled()
    exit.mockRestore()
  })

  it("refuses to target the main repository worktree", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/project") // == gitRoot
    // canonical 比較ヘルパは worktree.js モックで auto-mock されるため、ここでは
    // 同一パス判定 (true) を返させてガードを発火させる。
    vi.mocked(worktreeModule.isSamePath).mockReturnValue(true)
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await expect(command.parseAsync(["main"], { from: "user" })).rejects.toThrow("exit")
    expect(exit).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
    expect(createModule.setupVolumeCopy).not.toHaveBeenCalled()
    exit.mockRestore()
  })

  it("is a no-op (exit 0) when docker_compose_file is unset", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/project-feature")
    vi.mocked(loaderModule.loadConfig).mockReturnValue({
      base_branch: "main",
      docker_compose_file: "",
      copy_files: [],
      link_files: [],
      env: { file: [], adjust: {} },
      volumes: { exclude: [] },
    })

    await command.parseAsync(["feature/x"], { from: "user" })

    expect(createModule.setupVolumeCopy).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No docker_compose_file configured"))
  })

  it("surfaces a NOT-isolated warning when a volume fails", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/project-feature")
    vi.mocked(createModule.setupVolumeCopy).mockResolvedValue({ copied: 0, skipped: 0, failed: 2 })

    await command.parseAsync(["feature/x"], { from: "user" })

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("data is NOT fully isolated"))
  })

  it("exits 0 by default even when a volume fails (worktree still exists)", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/project-feature")
    vi.mocked(createModule.setupVolumeCopy).mockResolvedValue({ copied: 0, skipped: 0, failed: 1 })
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    // 既定では失敗しても process.exit を呼ばない（= 例外を投げない）。
    await command.parseAsync(["feature/x"], { from: "user" })
    expect(exit).not.toHaveBeenCalled()
    exit.mockRestore()
  })

  it("exits non-zero with --strict when a volume fails", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/project-feature")
    vi.mocked(createModule.setupVolumeCopy).mockResolvedValue({ copied: 0, skipped: 0, failed: 2 })
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await expect(command.parseAsync(["feature/x", "--strict"], { from: "user" })).rejects.toThrow(
      "exit"
    )
    expect(exit).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("data is NOT fully isolated"))
    exit.mockRestore()
  })

  it("exits 0 with --strict when all volumes succeed", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/project-feature")
    vi.mocked(createModule.setupVolumeCopy).mockResolvedValue({ copied: 2, skipped: 0, failed: 0 })
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await command.parseAsync(["feature/x", "--strict"], { from: "user" })
    expect(exit).not.toHaveBeenCalled()
    exit.mockRestore()
  })
})
