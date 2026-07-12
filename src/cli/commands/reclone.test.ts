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
    vi.mocked(repositoryModule.getMainWorktreeRoot).mockReturnValue("/project")
    vi.mocked(repositoryModule.getRepositoryContext).mockReturnValue({
      currentRoot: "/project-feature",
      mainRoot: "/project",
      commonGitDir: "/project/.git",
    })
    vi.mocked(loaderModule.loadConfig).mockReturnValue({
      base_branch: "main",
      docker_compose_file: "./docker-compose.yml",
      copy_files: [],
      link_files: [],
      env: { file: [], adjust: {} },
      volumes: { exclude: [] },
    })
    vi.mocked(createModule.setupVolumeCopy).mockResolvedValue({
      cloned: ["postgres_data"],
      skipped: [],
      failed: [],
    })
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
    expect(flags).toContain("--json")
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
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/project", branch: "main", head: "a" },
    ])
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await expect(command.parseAsync(["nope"], { from: "user" })).rejects.toThrow("exit")
    expect(exit).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
    expect(createModule.setupVolumeCopy).not.toHaveBeenCalled()
    // エラー診断の worktree 一覧は stderr に出し、stdout は汚さない
    expect(errorSpy).toHaveBeenCalledWith("Available worktrees:")
    expect(errorSpy).toHaveBeenCalledWith("  main: /project")
    expect(logSpy).not.toHaveBeenCalledWith("Available worktrees:")
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
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("No docker_compose_file configured")
    )
  })

  it("surfaces a NOT-isolated warning when a volume fails", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/project-feature")
    vi.mocked(createModule.setupVolumeCopy).mockResolvedValue({
      cloned: [],
      skipped: [],
      failed: [
        { name: "postgres_data", error: "boom" },
        { name: "cache", error: "boom" },
      ],
    })

    await command.parseAsync(["feature/x"], { from: "user" })

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("data is NOT fully isolated"))
  })

  it("exits 0 by default even when a volume fails (worktree still exists)", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/project-feature")
    vi.mocked(createModule.setupVolumeCopy).mockResolvedValue({
      cloned: [],
      skipped: [],
      failed: [{ name: "postgres_data", error: "boom" }],
    })
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
    vi.mocked(createModule.setupVolumeCopy).mockResolvedValue({
      cloned: [],
      skipped: [],
      failed: [
        { name: "postgres_data", error: "boom" },
        { name: "cache", error: "boom" },
      ],
    })
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

  it("--json emits exactly one JSON object on stdout and routes progress to stderr", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/project-feature")
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await command.parseAsync(["feature/x", "--json"], { from: "user" })

    expect(writeSpy).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
    expect(payload).toEqual({
      branch: "feature/x",
      path: "/project-feature",
      dryRun: false,
      volumes: { cloned: ["postgres_data"], skipped: [], failed: [] },
      sourceRestartFailed: false,
      ok: true,
    })
    // stdout purity: 人間向け出力は stderr に逃がす
    expect(logSpy).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Reclone complete"))
    writeSpy.mockRestore()
  })

  it("--json --strict keeps the JSON intact and signals failure via process.exitCode", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/project-feature")
    vi.mocked(createModule.setupVolumeCopy).mockResolvedValue({
      cloned: [],
      skipped: [],
      failed: [{ name: "postgres_data", error: "boom" }],
    })
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await command.parseAsync(["feature/x", "--json", "--strict"], { from: "user" })

    // JSON モードでは即 process.exit せず exitCode を設定する (stdout flush 保護)
    expect(exit).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(EXIT_CODES.GENERAL_ERROR)
    const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
    expect(payload.ok).toBe(false)
    expect(payload.volumes.failed).toEqual([{ name: "postgres_data", error: "boom" }])
    process.exitCode = undefined
    writeSpy.mockRestore()
    exit.mockRestore()
  })

  it("exits 0 with --strict when all volumes succeed", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/project-feature")
    vi.mocked(createModule.setupVolumeCopy).mockResolvedValue({
      cloned: ["postgres_data", "cache"],
      skipped: [],
      failed: [],
    })
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await command.parseAsync(["feature/x", "--strict"], { from: "user" })
    expect(exit).not.toHaveBeenCalled()
    exit.mockRestore()
  })

  // ── H5: source スタックが停止後に再開失敗 → DOCKER_ERROR (5) ─────────────────
  describe("source-restart-failure exit code (H5)", () => {
    const restartFailed = {
      cloned: ["postgres_data"],
      skipped: [],
      failed: [],
      sourceStack: {
        stopped: true,
        restarted: false,
        restartError: "boom",
        recoverCommand: "docker compose -f x -p y up -d",
      },
    }

    afterEach(() => {
      process.exitCode = undefined
    })

    it("sets process.exitCode=5 (DOCKER_ERROR) in human mode when the source stack fails to restart", async () => {
      vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/project-feature")
      vi.mocked(createModule.setupVolumeCopy).mockResolvedValue(restartFailed)
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit")
      })

      await command.parseAsync(["feature/x"], { from: "user" })

      // process.exit ではなく exitCode を設定する (JSON flush 保護と同じ流儀)。
      expect(exit).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(EXIT_CODES.DOCKER_ERROR)
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("source environment is DOWN"))
      exit.mockRestore()
    })

    it("--json still flushes its payload and sets exitCode=5", async () => {
      vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/project-feature")
      vi.mocked(createModule.setupVolumeCopy).mockResolvedValue(restartFailed)
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      await command.parseAsync(["feature/x", "--json"], { from: "user" })

      expect(process.exitCode).toBe(EXIT_CODES.DOCKER_ERROR)
      expect(writeSpy).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload.sourceRestartFailed).toBe(true)
      expect(payload.ok).toBe(false)
      writeSpy.mockRestore()
    })

    it("treats recovery failure after an incomplete stop as DOCKER_ERROR too", async () => {
      vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/project-feature")
      vi.mocked(createModule.setupVolumeCopy).mockResolvedValue({
        cloned: [],
        skipped: [],
        failed: [{ name: "postgres_data", error: "could not safely stop source stack" }],
        sourceStack: {
          stopped: false,
          restarted: false,
          stopError: "stop timed out",
          restartError: "up failed",
          recoverCommand: "docker compose -f x -p y up -d",
        },
      })

      await command.parseAsync(["feature/x"], { from: "user" })

      expect(process.exitCode).toBe(EXIT_CODES.DOCKER_ERROR)
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("source environment is DOWN"))
    })
  })
})
