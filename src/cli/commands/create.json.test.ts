/**
 * @fileoverview create コマンドの --json / --exists-ok のユニットテスト
 *
 * --json では stdout が機械可読な JSON 1 オブジェクトのみで、人間向け出力が
 * stderr へ逃がされること (stdout purity)、--exists-ok では既存 worktree を
 * 触らず exit 0 で返ること、非 flag 時は専用 exit code 6 (WORKTREE_EXISTS) を
 * 検証する。重い phase (docker / volume / env) は config を空にして回避する。
 */

import type { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EXIT_CODES } from "../../constants/index.js"
import * as loaderModule from "../../core/config/loader.js"
import * as repositoryModule from "../../core/git/repository.js"
import * as worktreeModule from "../../core/git/worktree.js"
import * as execModule from "../../utils/exec.js"
import { createCommand } from "./create.js"

vi.mock("../../core/config/loader.js")
vi.mock("../../core/git/repository.js")
vi.mock("../../core/git/worktree.js")
vi.mock("../../utils/exec.js")

describe("create command --json / --exists-ok", () => {
  let command: Command
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let writeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    command = createCommand()
    vi.mocked(repositoryModule.getGitRootOrThrow).mockReturnValue("/repo")
    vi.mocked(repositoryModule.getRepositoryContext).mockReturnValue({
      currentRoot: "/repo",
      mainRoot: "/repo",
      commonGitDir: "/repo/.git",
    })
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
    errorSpy.mockRestore()
    writeSpy.mockRestore()
  })

  /** stdout に書かれた唯一の JSON オブジェクトをパースして返す */
  const parsePayload = () => {
    expect(writeSpy).toHaveBeenCalledTimes(1)
    return JSON.parse(writeSpy.mock.calls[0][0] as string)
  }

  it("--json prints exactly one JSON object on stdout and keeps stdout free of human output", async () => {
    await command.parseAsync(["feature/x", "--json"], { from: "user" })

    const payload = parsePayload()
    expect(payload).toMatchObject({
      branch: "feature/x",
      created: true,
      existing: false,
      createdBranch: true,
      dryRun: false,
      env: {},
      composePorts: {},
      volumes: { cloned: [], skipped: [], failed: [] },
      seed: null,
      startCommand: null,
      ok: true,
    })
    expect(payload.path).toContain("worktree-feature-x")
    // stdout purity: 人間向けの進捗は --json では stderr に出る
    expect(logSpy).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Creating worktree"))
  })

  it("--json --dry-run reports dryRun:true / created:false without touching git", async () => {
    await command.parseAsync(["feature/x", "--json", "--dry-run"], { from: "user" })

    expect(worktreeModule.createWorktree).not.toHaveBeenCalled()
    const payload = parsePayload()
    expect(payload).toMatchObject({ dryRun: true, created: false, ok: true })
    expect(logSpy).not.toHaveBeenCalled()
  })

  it("surfaces optional missing files as setupWarnings without failing create", async () => {
    vi.mocked(loaderModule.loadConfig).mockReturnValue({
      base_branch: "main",
      docker_compose_file: "",
      copy_files: ["missing.local"],
      link_files: [],
      env: { file: [], adjust: {} },
      volumes: { exclude: [] },
    })

    await command.parseAsync(["feature/x", "--json"], { from: "user" })

    const payload = parsePayload()
    expect(payload.setupWarnings).toEqual([
      expect.objectContaining({ phase: "copy", path: "missing.local" }),
    ])
    expect(payload.setupFailures).toEqual([])
    expect(payload.ok).toBe(true)
  })

  it("surfaces runtime path failures and makes --strict non-zero", async () => {
    vi.mocked(loaderModule.loadConfig).mockReturnValue({
      base_branch: "main",
      docker_compose_file: "",
      copy_files: ["../unsafe"],
      link_files: [],
      env: { file: [], adjust: {} },
      volumes: { exclude: [] },
    })
    process.exitCode = undefined

    await command.parseAsync(["feature/x", "--json", "--strict"], { from: "user" })

    const payload = parsePayload()
    expect(payload.setupFailures).toEqual([
      expect.objectContaining({ phase: "copy", path: "../unsafe" }),
    ])
    expect(payload.ok).toBe(false)
    expect(process.exitCode).toBe(EXIT_CODES.GENERAL_ERROR)
    process.exitCode = undefined
  })

  it("rejects --seed with --no-docker before creating a worktree", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited")
    })

    await expect(
      command.parseAsync(["feature/x", "--seed", "--no-docker"], { from: "user" })
    ).rejects.toThrow("exited")

    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
    expect(worktreeModule.createWorktree).not.toHaveBeenCalled()
    exitSpy.mockRestore()
  })

  it("--exists-ok prints the existing path and exits 0 without touching the worktree", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/existing/worktree-feature-x")

    await command.parseAsync(["feature/x", "--exists-ok"], { from: "user" })

    expect(worktreeModule.createWorktree).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("/existing/worktree-feature-x"))
  })

  it("--exists-ok --json emits created:false / existing:true", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/existing/worktree-feature-x")

    await command.parseAsync(["feature/x", "--exists-ok", "--json"], { from: "user" })

    expect(worktreeModule.createWorktree).not.toHaveBeenCalled()
    const payload = parsePayload()
    expect(payload).toMatchObject({
      branch: "feature/x",
      path: "/existing/worktree-feature-x",
      created: false,
      existing: true,
      ok: true,
    })
    expect(logSpy).not.toHaveBeenCalled()
  })

  it("checks existence while holding the repository lock and releases on early return", async () => {
    const release = vi.fn().mockResolvedValue(undefined)
    vi.mocked(repositoryModule.acquireRepositoryLock).mockResolvedValue(release)
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/existing/worktree-feature-x")

    await command.parseAsync(["feature/x", "--exists-ok"], { from: "user" })

    expect(repositoryModule.acquireRepositoryLock).toHaveBeenCalledWith({
      currentRoot: "/repo",
      mainRoot: "/repo",
      commonGitDir: "/repo/.git",
    })
    expect(
      vi.mocked(repositoryModule.acquireRepositoryLock).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(worktreeModule.getWorktreePath).mock.invocationCallOrder[0])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it("fails with dedicated exit code 6 (WORKTREE_EXISTS) when the worktree exists without --exists-ok", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue("/existing/worktree-feature-x")
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited")
    })

    await expect(command.parseAsync(["feature/x"], { from: "user" })).rejects.toThrow("exited")

    expect(EXIT_CODES.WORKTREE_EXISTS).toBe(6)
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.WORKTREE_EXISTS)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("already exists"))
    expect(worktreeModule.createWorktree).not.toHaveBeenCalled()
    exitSpy.mockRestore()
  })

  it("human mode lists `wtb ports --pretty` in the Next steps block", async () => {
    await command.parseAsync(["feature/x"], { from: "user" })

    expect(logSpy).toHaveBeenCalledWith(
      "  wtb ports --pretty   # see this worktree's assigned ports"
    )
  })

  describe("--strict", () => {
    /** volumes.seed_command を設定し、seed 失敗/成功で strict 分岐を駆動する */
    const configureSeed = () => {
      vi.mocked(loaderModule.loadConfig).mockReturnValue({
        base_branch: "main",
        docker_compose_file: "",
        copy_files: [],
        link_files: [],
        env: { file: [], adjust: {} },
        volumes: { exclude: [], seed_command: "npm run db:seed" },
      })
    }

    it("signals failure via process.exitCode when the seed command fails (human mode)", async () => {
      configureSeed()
      vi.mocked(execModule.executeLifecycleCommand).mockImplementation(() => {
        throw new Error("seed boom")
      })
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exited")
      })
      process.exitCode = undefined

      await command.parseAsync(["feature/x", "--seed", "--strict"], { from: "user" })

      // 人間モードでも即 process.exit せず exitCode を設定する (buffered stdout の flush 保護)。
      expect(exitSpy).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(EXIT_CODES.GENERAL_ERROR)
      process.exitCode = undefined
      exitSpy.mockRestore()
    })

    it("--json keeps the JSON payload intact and signals failure via process.exitCode", async () => {
      configureSeed()
      vi.mocked(execModule.executeLifecycleCommand).mockImplementation(() => {
        throw new Error("seed boom")
      })
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exited")
      })

      await command.parseAsync(["feature/x", "--seed", "--strict", "--json"], { from: "user" })

      // JSON モードでは即 process.exit せず exitCode を設定する (stdout flush 保護)
      expect(exitSpy).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(EXIT_CODES.GENERAL_ERROR)
      const payload = parsePayload()
      expect(payload.ok).toBe(false)
      expect(payload.seed).toEqual({ ran: true, failed: true })
      expect(logSpy).not.toHaveBeenCalled()
      process.exitCode = undefined
      exitSpy.mockRestore()
    })

    it("exits 0 when the seed command succeeds", async () => {
      configureSeed()
      // clearAllMocks は実装を消さないため、前のテストの throw 実装を明示的に外す
      vi.mocked(execModule.executeLifecycleCommand).mockReset()
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exited")
      })

      await command.parseAsync(["feature/x", "--seed", "--strict"], { from: "user" })

      expect(exitSpy).not.toHaveBeenCalled()
      exitSpy.mockRestore()
    })
  })
})
