/**
 * @fileoverview remove コマンドのユニットテスト
 *
 * 破壊的処理の順序ガードを最優先で検証する:
 * - dirty worktree は volume 削除 (docker compose down) より前に fail fast すること
 * - 設定された docker_compose_file が `-f` で明示的に渡されること
 * - unknown branch のエラー診断が stdout を汚さないこと
 */

import { existsSync } from "node:fs"
import * as path from "node:path"
import type { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EXIT_CODES } from "../../constants/index.js"
import * as loaderModule from "../../core/config/loader.js"
import * as composeModule from "../../core/docker/compose.js"
import * as volumeModule from "../../core/docker/volume.js"
import * as repositoryModule from "../../core/git/repository.js"
import * as worktreeModule from "../../core/git/worktree.js"
import { CLIError } from "../../utils/error.js"
import * as execModule from "../../utils/exec.js"
import { removeCommand } from "./remove.js"

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}))
vi.mock("../../core/config/loader.js")
vi.mock("../../core/docker/compose.js")
vi.mock("../../core/docker/project-ownership.js")
vi.mock("../../core/docker/volume.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/docker/volume.js")>()
  return {
    ...actual,
    inspectVolumeOwnership: vi.fn(),
    readVolumeRecoveryRecords: vi.fn(),
    repoVolumeLabel: vi.fn(),
    volumeExistsOrThrow: vi.fn(),
  }
})
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
    // clearAllMocks は implementation を消さないため、テスト内で上書きした existsSync を
    // 毎回既定 (true) に戻す。
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(repositoryModule.getRepositoryContext).mockReturnValue({
      currentRoot: "/repo",
      mainRoot: "/repo",
      commonGitDir: "/repo/.git",
    })
    vi.mocked(worktreeModule.isSamePath).mockReturnValue(false)
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/repo", branch: "main", head: "main-sha" },
      { path: WORKTREE_PATH, branch: "feature/x", head: "feature-sha" },
    ])
    // B1: manifest 既定は空 (managed ファイルなし)。dirty チェックは素の git status に従う。
    vi.mocked(worktreeModule.loadWtbManagedManifest).mockReturnValue({})
    vi.mocked(worktreeModule.listSkipWorktreePaths).mockReturnValue([])
    vi.mocked(worktreeModule.gitHashObject).mockReturnValue(null)
    vi.mocked(worktreeModule.clearSkipWorktree).mockReturnValue(true)
    vi.mocked(worktreeModule.markSkipWorktreeIfTracked).mockReturnValue(true)
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
    // compose の project 解決: source(/repo) と worktree で別プロジェクトを返す
    // (一致すると teardown はソース保護のため skip される)。
    vi.mocked(composeModule.safeResolveComposeProjectName).mockImplementation((_path, workdir) =>
      workdir === "/repo" ? "srcproj" : "wtproj"
    )
    vi.mocked(composeModule.readComposeFile).mockReturnValue({
      services: {},
      volumes: {},
    })
    vi.mocked(composeModule.withComposeSnapshot).mockImplementation(
      (sourcePath, _config, operation) => operation(sourcePath)
    )
    vi.mocked(volumeModule.repoVolumeLabel).mockReturnValue("repo-label")
    vi.mocked(volumeModule.readVolumeRecoveryRecords).mockReturnValue([])
    vi.mocked(volumeModule.volumeExistsOrThrow).mockReturnValue(false)
    vi.mocked(volumeModule.inspectVolumeOwnership).mockReturnValue({
      managed: true,
      repo: "repo-label",
      project: "wtproj",
      branch: "feature/x",
      temp: false,
      labels: {},
    })
  })

  afterEach(() => {
    process.exitCode = undefined
    logSpy.mockRestore()
    errorSpy.mockRestore()
    vi.restoreAllMocks()
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
    expect(execModule.execGitSafe).toHaveBeenCalledWith(
      ["-c", "core.quotePath=false", "status", "--porcelain"],
      {
        cwd: WORKTREE_PATH,
        preserveLeadingWhitespace: true,
      }
    )
    // 破壊的処理は一切走らないこと
    expect(composeModule.composeDown).not.toHaveBeenCalled()
    expect(worktreeModule.removeWorktree).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("uncommitted or untracked"))
    exit.mockRestore()
  })

  it("skips the dirty check with -f and forwards force to git", async () => {
    await command.parseAsync(["feature/x", "-f"], { from: "user" })

    expect(execModule.execGitSafe).not.toHaveBeenCalled()
    expect(worktreeModule.removeWorktree).toHaveBeenCalledWith(WORKTREE_PATH, {
      force: true,
      cwd: "/repo",
    })
  })

  it("passes the configured compose file and worktree project to composeDown", async () => {
    await command.parseAsync(["feature/x"], { from: "user" })

    expect(composeModule.composeDown).toHaveBeenCalledWith(
      path.resolve(WORKTREE_PATH, "compose.dev.yml"),
      "wtproj",
      WORKTREE_PATH,
      false
    )
    // manifest が空 (managed ファイルなし) かつ clean なので force は不要 (false)。
    expect(worktreeModule.removeWorktree).toHaveBeenCalledWith(WORKTREE_PATH, {
      force: false,
      cwd: "/repo",
    })
  })

  it("tears down a branch-only target Compose when the main source file is absent", async () => {
    vi.mocked(existsSync).mockImplementation((value) =>
      path.resolve(String(value)) !== path.resolve("/repo/compose.dev.yml")
    )

    await command.parseAsync(["feature/x"], { from: "user" })

    expect(composeModule.composeDown).toHaveBeenCalled()
    expect(worktreeModule.removeWorktree).toHaveBeenCalled()
  })

  it("requests volume removal (down -v) with --remove-volumes", async () => {
    await command.parseAsync(["feature/x", "--remove-volumes"], { from: "user" })

    expect(composeModule.composeDown).toHaveBeenCalledWith(
      path.resolve(WORKTREE_PATH, "compose.dev.yml"),
      "wtproj",
      WORKTREE_PATH,
      true
    )
  })

  describe("--remove-volumes ownership guard", () => {
    it("refuses an existing unmanaged explicit volume such as prod_db", async () => {
      vi.mocked(composeModule.readComposeFile).mockReturnValue({
        services: {},
        volumes: { db: { name: "prod_db" } },
      })
      vi.mocked(volumeModule.volumeExistsOrThrow).mockReturnValue(true)
      vi.mocked(volumeModule.inspectVolumeOwnership).mockReturnValue({
        managed: false,
        temp: false,
        labels: {},
      })
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      await command.parseAsync(["feature/x", "--remove-volumes", "--json"], { from: "user" })

      expect(volumeModule.volumeExistsOrThrow).toHaveBeenCalledWith("prod_db")
      expect(volumeModule.inspectVolumeOwnership).toHaveBeenCalledWith("prod_db")
      expect(composeModule.composeDown).not.toHaveBeenCalled()
      expect(worktreeModule.removeWorktree).not.toHaveBeenCalled()
      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload.composeDown).toEqual({
        ran: false,
        failed: true,
        volumesRemoved: false,
        skippedReason: "volume-ownership",
      })
      expect(payload.cleanupErrors.join(" ")).toContain("prod_db")
      expect(process.exitCode).toBe(EXIT_CODES.GENERAL_ERROR)
    })

    it("refuses a managed volume owned by another repository, project, or branch", async () => {
      vi.mocked(composeModule.readComposeFile).mockReturnValue({
        services: {},
        volumes: { db: null },
      })
      vi.mocked(volumeModule.volumeExistsOrThrow).mockReturnValue(true)
      vi.mocked(volumeModule.inspectVolumeOwnership).mockReturnValue({
        managed: true,
        repo: "another-repo",
        project: "srcproj",
        branch: "main",
        temp: false,
        labels: {},
      })
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      await command.parseAsync(["feature/x", "--remove-volumes", "--json"], { from: "user" })

      expect(composeModule.composeDown).not.toHaveBeenCalled()
      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload.removed).toBe(false)
      expect(payload.cleanupErrors.join(" ")).toContain("foreign")
    })

    it("refuses a temporary staging volume even when its owner labels otherwise match", async () => {
      vi.mocked(composeModule.readComposeFile).mockReturnValue({
        services: {},
        volumes: { db: null },
      })
      vi.mocked(volumeModule.volumeExistsOrThrow).mockReturnValue(true)
      vi.mocked(volumeModule.inspectVolumeOwnership).mockReturnValue({
        managed: true,
        repo: "repo-label",
        project: "wtproj",
        branch: "feature/x",
        temp: true,
        labels: {},
      })
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      await command.parseAsync(["feature/x", "--remove-volumes", "--json"], { from: "user" })

      expect(composeModule.composeDown).not.toHaveBeenCalled()
      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload.removed).toBe(false)
      expect(payload.cleanupErrors.join(" ")).toContain("temporary")
    })

    it("allows only an exactly owned non-temporary volume and revalidates before down", async () => {
      vi.mocked(composeModule.readComposeFile).mockReturnValue({
        services: {},
        volumes: { db: null },
      })
      vi.mocked(volumeModule.volumeExistsOrThrow).mockReturnValue(true)
      const owned = {
        managed: true,
        repo: "repo-label",
        project: "wtproj",
        branch: "feature/x",
        temp: false,
        labels: {},
      }
      vi.mocked(volumeModule.inspectVolumeOwnership).mockReturnValue(owned)

      await command.parseAsync(["feature/x", "--remove-volumes"], { from: "user" })

      expect(composeModule.readComposeFile).toHaveBeenCalledTimes(2)
      expect(volumeModule.volumeExistsOrThrow).toHaveBeenCalledTimes(2)
      expect(volumeModule.volumeExistsOrThrow).toHaveBeenNthCalledWith(1, "wtproj_db")
      expect(volumeModule.volumeExistsOrThrow).toHaveBeenNthCalledWith(2, "wtproj_db")
      expect(volumeModule.inspectVolumeOwnership).toHaveBeenCalledTimes(2)
      expect(composeModule.composeDown).toHaveBeenCalledWith(
        path.resolve(WORKTREE_PATH, "compose.dev.yml"),
        "wtproj",
        WORKTREE_PATH,
        true
      )
    })

    it("excludes external volumes from ownership checks because down -v does not remove them", async () => {
      vi.mocked(composeModule.readComposeFile).mockReturnValue({
        services: {},
        volumes: { database: { external: true, name: "prod_db" } },
      })

      await command.parseAsync(["feature/x", "--remove-volumes"], { from: "user" })

      expect(composeModule.readComposeFile).toHaveBeenCalledTimes(2)
      expect(volumeModule.volumeExistsOrThrow).not.toHaveBeenCalled()
      expect(volumeModule.inspectVolumeOwnership).not.toHaveBeenCalled()
      expect(composeModule.composeDown).toHaveBeenCalledWith(
        path.resolve(WORKTREE_PATH, "compose.dev.yml"),
        "wtproj",
        WORKTREE_PATH,
        true
      )
    })

    it("fails closed with Docker exit 5 when the daemon cannot verify volume existence", async () => {
      vi.mocked(composeModule.readComposeFile).mockReturnValue({
        services: {},
        volumes: { db: null },
      })
      vi.mocked(volumeModule.volumeExistsOrThrow).mockImplementation(() => {
        throw new Error("daemon unavailable")
      })
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      await command.parseAsync(["feature/x", "--remove-volumes", "--json"], { from: "user" })

      expect(composeModule.composeDown).not.toHaveBeenCalled()
      expect(worktreeModule.removeWorktree).not.toHaveBeenCalled()
      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload.removed).toBe(false)
      expect(payload.cleanupErrors.join(" ")).toContain("daemon unavailable")
      expect(process.exitCode).toBe(EXIT_CODES.DOCKER_ERROR)
    })

    it("--force removes only the worktree after an ownership failure and remains non-zero", async () => {
      vi.mocked(composeModule.readComposeFile).mockReturnValue({
        services: {},
        volumes: { db: { name: "prod_db" } },
      })
      vi.mocked(volumeModule.volumeExistsOrThrow).mockReturnValue(true)
      vi.mocked(volumeModule.inspectVolumeOwnership).mockReturnValue({
        managed: false,
        temp: false,
        labels: {},
      })
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      await command.parseAsync(
        ["feature/x", "--remove-volumes", "--force", "--json"],
        { from: "user" }
      )

      expect(composeModule.composeDown).not.toHaveBeenCalled()
      expect(worktreeModule.removeWorktree).toHaveBeenCalledWith(WORKTREE_PATH, {
        force: true,
        cwd: "/repo",
      })
      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload).toMatchObject({ removed: true, ok: false })
      expect(payload.composeDown.skippedReason).toBe("volume-ownership")
      expect(process.exitCode).toBe(EXIT_CODES.GENERAL_ERROR)
    })
  })

  it("refuses teardown (protects source) when the worktree resolves to the source project", async () => {
    // COMPOSE_PROJECT_NAME 相当: source と worktree が同一プロジェクトに解決される。
    vi.mocked(composeModule.safeResolveComposeProjectName).mockReturnValue("srcproj")
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await expect(
      command.parseAsync(["feature/x", "--remove-volumes"], { from: "user" })
    ).rejects.toThrow("exit")

    // down は一切呼ばれない (source を巻き込まないため)。
    expect(composeModule.composeDown).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("same project")
    )
    // cleanup 未達成なので通常は worktree を保持する。
    expect(worktreeModule.removeWorktree).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
  })

  it("B1: ignores a managed file that still equals wtb's output and force-removes the worktree", async () => {
    // manifest に compose.dev.yml: "sha-wtb" を記録。git status はその 1 ファイルだけ
    // modified を返すが、hash-object が同じ sha を返す = wtb の出力そのまま → not dirty。
    vi.mocked(worktreeModule.loadWtbManagedManifest).mockReturnValue({
      "compose.dev.yml": "sha-wtb",
    })
    vi.mocked(worktreeModule.gitHashObject).mockReturnValue("sha-wtb")
    vi.mocked(execModule.execGitSafe).mockImplementation((args) =>
      args[0] === "diff" ? "" : " M compose.dev.yml"
    )

    await command.parseAsync(["feature/x"], { from: "user" })

    // managed ファイルの skip-worktree を一旦解除して真の状態を surface させる。
    expect(worktreeModule.clearSkipWorktree).toHaveBeenCalledWith(WORKTREE_PATH, "compose.dev.yml")
    // dirty 判定を通過し、managed 書き換えが残るため最終削除は force される。
    expect(worktreeModule.removeWorktree).toHaveBeenCalledWith(WORKTREE_PATH, {
      force: true,
      cwd: "/repo",
    })
  })

  it("rechecks all status entries after cleanup before using the internal force", async () => {
    let cleanupFinished = false
    vi.mocked(worktreeModule.loadWtbManagedManifest).mockReturnValue({
      "compose.dev.yml": "sha-wtb",
    })
    vi.mocked(worktreeModule.listSkipWorktreePaths)
      .mockReturnValueOnce(["compose.dev.yml"])
      .mockReturnValue([])
    vi.mocked(worktreeModule.gitHashObject).mockReturnValue("sha-wtb")
    vi.mocked(execModule.execGitSafe).mockImplementation((args) => {
      if (args[0] === "diff") return ""
      return cleanupFinished ? " M compose.dev.yml\n?? late-notes.txt" : " M compose.dev.yml"
    })
    vi.mocked(composeModule.composeDown).mockImplementation(() => {
      cleanupFinished = true
    })
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await command.parseAsync(["feature/x", "--json"], { from: "user" })

    const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
    expect(payload.removed).toBe(false)
    expect(payload.cleanupErrors.join(" ")).toContain("changed during cleanup")
    expect(composeModule.composeDown).toHaveBeenCalled()
    expect(worktreeModule.removeWorktree).not.toHaveBeenCalled()
    // The worktree remains, so unchanged managed files regain their original protection.
    expect(worktreeModule.markSkipWorktreeIfTracked).toHaveBeenCalledWith(
      "compose.dev.yml",
      WORKTREE_PATH
    )
  })

  it.each([
    { change: "managed bytes", lateSha: "sha-user", lateMode: "" },
    {
      change: "managed mode",
      lateSha: "sha-wtb",
      lateMode: " mode change 100644 => 100755 compose.dev.yml",
    },
  ])("rechecks $change after cleanup before internal force", async ({ lateSha, lateMode }) => {
    let cleanupFinished = false
    vi.mocked(worktreeModule.loadWtbManagedManifest).mockReturnValue({
      "compose.dev.yml": "sha-wtb",
    })
    vi.mocked(worktreeModule.listSkipWorktreePaths)
      .mockReturnValueOnce(["compose.dev.yml"])
      .mockReturnValue([])
    vi.mocked(worktreeModule.gitHashObject).mockImplementation(() =>
      cleanupFinished ? lateSha : "sha-wtb"
    )
    vi.mocked(execModule.execGitSafe).mockImplementation((args) => {
      if (args[0] === "diff") return cleanupFinished ? lateMode : ""
      return " M compose.dev.yml"
    })
    vi.mocked(composeModule.composeDown).mockImplementation(() => {
      cleanupFinished = true
    })
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await command.parseAsync(["feature/x", "--json"], { from: "user" })

    const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
    expect(payload.removed).toBe(false)
    expect(payload.cleanupErrors.join(" ")).toContain("changed during cleanup")
    expect(worktreeModule.removeWorktree).not.toHaveBeenCalled()
  })

  it("does not apply the late-change guard to an explicit --force", async () => {
    let cleanupFinished = false
    vi.mocked(worktreeModule.loadWtbManagedManifest).mockReturnValue({
      "compose.dev.yml": "sha-wtb",
    })
    vi.mocked(worktreeModule.listSkipWorktreePaths).mockReturnValue(["compose.dev.yml"])
    vi.mocked(composeModule.composeDown).mockImplementation(() => {
      cleanupFinished = true
    })
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await command.parseAsync(["feature/x", "--force", "--json"], { from: "user" })

    expect(cleanupFinished).toBe(true)
    const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
    expect(payload.removed).toBe(true)
    expect(worktreeModule.removeWorktree).toHaveBeenCalledWith(WORKTREE_PATH, {
      force: true,
      cwd: "/repo",
    })
    // Only the initial hidden-path audit runs; explicit force bypasses both dirty snapshots.
    expect(worktreeModule.listSkipWorktreePaths).toHaveBeenCalledTimes(1)
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
    expect(composeModule.composeDown).not.toHaveBeenCalled()
    exit.mockRestore()
  })

  it("blocks staged or mode-only changes to a managed file even when its blob sha matches", async () => {
    vi.mocked(worktreeModule.loadWtbManagedManifest).mockReturnValue({
      "compose.dev.yml": "sha-wtb",
    })
    vi.mocked(worktreeModule.gitHashObject).mockReturnValue("sha-wtb")
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    vi.mocked(execModule.execGitSafe).mockReturnValue("M  compose.dev.yml")
    await expect(command.parseAsync(["feature/x"], { from: "user" })).rejects.toThrow("exit")
    expect(worktreeModule.removeWorktree).not.toHaveBeenCalled()

    vi.clearAllMocks()
    // Re-establish the per-test defaults cleared above, then exercise an unstaged mode change.
    vi.mocked(repositoryModule.getRepositoryContext).mockReturnValue({
      currentRoot: "/repo",
      mainRoot: "/repo",
      commonGitDir: "/repo/.git",
    })
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/repo", branch: "main", head: "main-sha" },
      { path: WORKTREE_PATH, branch: "feature/x", head: "feature-sha" },
    ])
    vi.mocked(worktreeModule.isSamePath).mockReturnValue(false)
    vi.mocked(worktreeModule.loadWtbManagedManifest).mockReturnValue({
      "compose.dev.yml": "sha-wtb",
    })
    vi.mocked(worktreeModule.gitHashObject).mockReturnValue("sha-wtb")
    vi.mocked(worktreeModule.clearSkipWorktree).mockReturnValue(true)
    vi.mocked(worktreeModule.markSkipWorktreeIfTracked).mockReturnValue(true)
    vi.mocked(loaderModule.loadConfig).mockReturnValue({
      base_branch: "main",
      docker_compose_file: "compose.dev.yml",
      copy_files: [],
      link_files: [],
      env: { file: [], adjust: {} },
      volumes: { exclude: [] },
    })
    vi.mocked(execModule.execGitSafe).mockImplementation((args) =>
      args[0] === "diff" ? " mode change 100644 => 100755 compose.dev.yml" : " M compose.dev.yml"
    )
    await expect(removeCommand().parseAsync(["feature/x"], { from: "user" })).rejects.toThrow(
      "exit"
    )
    expect(worktreeModule.removeWorktree).not.toHaveBeenCalled()
  })

  it("aborts before cleanup if skip-worktree cannot be cleared", async () => {
    vi.mocked(worktreeModule.loadWtbManagedManifest).mockReturnValue({
      "compose.dev.yml": "sha-wtb",
    })
    vi.mocked(worktreeModule.clearSkipWorktree).mockReturnValue(false)
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await command.parseAsync(["feature/x", "--json"], { from: "user" })

    const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
    expect(payload.removed).toBe(false)
    expect(payload.cleanupErrors.join(" ")).toContain("failed to clear skip-worktree")
    expect(composeModule.composeDown).not.toHaveBeenCalled()
    expect(worktreeModule.removeWorktree).not.toHaveBeenCalled()
  })

  it("refuses a locked worktree before running cleanup", async () => {
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/repo", branch: "main", head: "main-sha" },
      { path: WORKTREE_PATH, branch: "feature/x", head: "feature-sha", locked: true },
    ])
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await expect(command.parseAsync(["feature/x", "-f"], { from: "user" })).rejects.toThrow(
      "exit"
    )

    expect(loaderModule.loadConfig).not.toHaveBeenCalled()
    expect(composeModule.composeDown).not.toHaveBeenCalled()
    expect(worktreeModule.removeWorktree).not.toHaveBeenCalled()
  })

  it("fails closed on a corrupt managed manifest even with --force", async () => {
    vi.mocked(worktreeModule.loadWtbManagedManifest).mockImplementation(() => {
      throw new Error("invalid JSON")
    })
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await command.parseAsync(["feature/x", "--force", "--json"], { from: "user" })

    const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
    expect(payload.removed).toBe(false)
    expect(payload.ok).toBe(false)
    expect(payload.cleanupErrors.join(" ")).toContain("invalid JSON")
    expect(composeModule.composeDown).not.toHaveBeenCalled()
    expect(worktreeModule.removeWorktree).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(EXIT_CODES.GENERAL_ERROR)
  })

  it("fails closed before cleanup when a missing manifest cannot explain an S-bit, even with --force", async () => {
    vi.mocked(worktreeModule.loadWtbManagedManifest).mockReturnValue({})
    vi.mocked(worktreeModule.listSkipWorktreePaths).mockReturnValue(["secrets.env"])
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await command.parseAsync(["feature/x", "--force", "--json"], { from: "user" })

    const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
    expect(payload.removed).toBe(false)
    expect(payload.ok).toBe(false)
    expect(payload.cleanupErrors.join(" ")).toContain("missing from the wtb-managed manifest")
    expect(payload.cleanupErrors.join(" ")).toContain("secrets.env")
    expect(worktreeModule.clearSkipWorktree).not.toHaveBeenCalled()
    expect(worktreeModule.markSkipWorktreeIfTracked).not.toHaveBeenCalled()
    expect(composeModule.composeDown).not.toHaveBeenCalled()
    expect(worktreeModule.removeWorktree).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(EXIT_CODES.GENERAL_ERROR)
  })

  it("fails closed for a valid but partial manifest without clearing any skip flags", async () => {
    vi.mocked(worktreeModule.loadWtbManagedManifest).mockReturnValue({
      "compose.dev.yml": "sha-wtb",
    })
    vi.mocked(worktreeModule.listSkipWorktreePaths).mockReturnValue([
      "compose.dev.yml",
      "hidden.txt",
    ])
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await command.parseAsync(["feature/x", "--json"], { from: "user" })

    const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
    expect(payload.removed).toBe(false)
    expect(payload.cleanupErrors.join(" ")).toContain("hidden.txt")
    expect(worktreeModule.clearSkipWorktree).not.toHaveBeenCalled()
    expect(composeModule.composeDown).not.toHaveBeenCalled()
    expect(worktreeModule.removeWorktree).not.toHaveBeenCalled()
  })

  it("fails closed when assume-unchanged prevents reliable inspection, even for a manifest path", async () => {
    vi.mocked(worktreeModule.loadWtbManagedManifest).mockReturnValue({
      "compose.dev.yml": "sha-wtb",
    })
    vi.mocked(worktreeModule.listSkipWorktreePaths).mockImplementation(() => {
      throw new Error(
        "Tracked path 'compose.dev.yml' has assume-unchanged set; its changes cannot be inspected safely"
      )
    })
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await command.parseAsync(["feature/x", "--force", "--json"], { from: "user" })

    const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
    expect(payload.removed).toBe(false)
    expect(payload.cleanupErrors.join(" ")).toContain("assume-unchanged")
    expect(worktreeModule.clearSkipWorktree).not.toHaveBeenCalled()
    expect(composeModule.composeDown).not.toHaveBeenCalled()
    expect(worktreeModule.removeWorktree).not.toHaveBeenCalled()
  })

  describe("--json", () => {
    it("emits exactly one JSON object on stdout and routes progress to stderr", async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      await command.parseAsync(["feature/x", "--json"], { from: "user" })

      expect(writeSpy).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload).toEqual({
        branch: "feature/x",
        path: WORKTREE_PATH,
        removed: true,
        forced: false,
        composeDown: { ran: true, failed: false, volumesRemoved: false, skippedReason: null },
        endCommand: null,
        cleanupErrors: [],
        ok: true,
      })
      // stdout purity: 人間向け出力は stderr に逃がす
      expect(logSpy).not.toHaveBeenCalled()
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("removed successfully"))
      writeSpy.mockRestore()
    })

    it("reports skippedReason 'same-project' when the worktree resolves to the source project", async () => {
      vi.mocked(composeModule.safeResolveComposeProjectName).mockReturnValue("srcproj")
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      await command.parseAsync(["feature/x", "--json"], { from: "user" })

      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload.composeDown).toEqual({
        ran: false,
        failed: true,
        volumesRemoved: false,
        skippedReason: "same-project",
      })
      expect(payload.removed).toBe(false)
      expect(payload.ok).toBe(false)
      expect(process.exitCode).toBe(EXIT_CODES.GENERAL_ERROR)
      writeSpy.mockRestore()
    })

    it("reports volumesRemoved:true with --remove-volumes", async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      await command.parseAsync(["feature/x", "--remove-volumes", "--json"], { from: "user" })

      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload.composeDown).toEqual({
        ran: true,
        failed: false,
        volumesRemoved: true,
        skippedReason: null,
      })
      expect(payload.ok).toBe(true)
      writeSpy.mockRestore()
    })

    it("reports skippedReason 'no-docker-flag' with --no-docker", async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      await command.parseAsync(["feature/x", "--no-docker", "--json"], { from: "user" })

      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload.composeDown).toEqual({
        ran: false,
        failed: false,
        volumesRemoved: false,
        skippedReason: "no-docker-flag",
      })
      expect(payload.ok).toBe(true)
      writeSpy.mockRestore()
    })

    it("reports skippedReason 'unresolvable-project' when the worktree project cannot be resolved", async () => {
      vi.mocked(composeModule.safeResolveComposeProjectName).mockImplementation((_path, workdir) =>
        workdir === "/repo" ? "srcproj" : null
      )
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      await command.parseAsync(["feature/x", "--json"], { from: "user" })

      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload.composeDown.skippedReason).toBe("unresolvable-project")
      expect(payload.removed).toBe(false)
      expect(payload.ok).toBe(false)
      writeSpy.mockRestore()
    })

    it("reports skippedReason 'compose-file-missing' when the worktree has no compose copy", async () => {
      // worktree 内の compose だけ欠損させる (他の existsSync 判定は素通し)。
      vi.mocked(existsSync).mockImplementation((p) => !String(p).endsWith("compose.dev.yml"))
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      await command.parseAsync(["feature/x", "--remove-volumes", "--json"], { from: "user" })

      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload.composeDown.skippedReason).toBe("compose-file-missing")
      expect(payload.composeDown.volumesRemoved).toBe(false)
      expect(payload.removed).toBe(false)
      expect(payload.ok).toBe(false)
      writeSpy.mockRestore()
    })

    it("reports composeDown:null when no docker_compose_file is configured", async () => {
      vi.mocked(loaderModule.loadConfig).mockReturnValue({
        base_branch: "main",
        copy_files: [],
        link_files: [],
        env: { file: [], adjust: {} },
        volumes: { exclude: [] },
      } as never)
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      await command.parseAsync(["feature/x", "--json"], { from: "user" })

      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload.composeDown).toBeNull()
      expect(payload.ok).toBe(true)
      writeSpy.mockRestore()
    })

    it("keeps the worktree when composeDown fails and returns Docker exit 5", async () => {
      vi.mocked(composeModule.composeDown).mockImplementation(() => {
        throw new Error("network in use")
      })
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
      await command.parseAsync(["feature/x", "--remove-volumes", "--json"], { from: "user" })

      expect(worktreeModule.removeWorktree).not.toHaveBeenCalled()
      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload.removed).toBe(false)
      expect(payload.composeDown).toEqual({
        ran: true,
        failed: true,
        volumesRemoved: false,
        skippedReason: null,
      })
      expect(payload.ok).toBe(false)
      expect(payload.cleanupErrors.join(" ")).toContain("network in use")
      expect(process.exitCode).toBe(EXIT_CODES.DOCKER_ERROR)
      writeSpy.mockRestore()
    })

    it("always emits the JSON contract when the repository safety lock cannot be acquired", async () => {
      vi.mocked(repositoryModule.acquireRepositoryLock).mockRejectedValueOnce(
        new Error("lock timeout")
      )
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      await command.parseAsync(["feature/x", "--remove-volumes", "--json"], {
        from: "user",
      })

      expect(writeSpy).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload).toMatchObject({ removed: false, ok: false })
      expect(payload.composeDown).toMatchObject({ ran: false, failed: true })
      expect(payload.cleanupErrors.join(" ")).toContain("lock timeout")
      expect(process.exitCode).toBe(EXIT_CODES.GENERAL_ERROR)
      writeSpy.mockRestore()
    })

    it("classifies post-Docker snapshot cleanup failure as general cleanup failure", async () => {
      vi.mocked(composeModule.withComposeSnapshot).mockImplementationOnce(
        (sourcePath, _config, operation) => {
          operation(sourcePath)
          throw new Error("snapshot unlink failed")
        }
      )
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      await command.parseAsync(["feature/x", "--remove-volumes", "--json"], {
        from: "user",
      })

      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload).toMatchObject({ removed: false, ok: false })
      expect(payload.composeDown).toMatchObject({ ran: true, failed: true })
      expect(payload.cleanupErrors.join(" ")).toContain("snapshot cleanup")
      expect(process.exitCode).toBe(EXIT_CODES.GENERAL_ERROR)
      writeSpy.mockRestore()
    })

    it("force-removes after composeDown failure but preserves ok:false and Docker exit 5", async () => {
      vi.mocked(composeModule.composeDown).mockImplementation(() => {
        throw new Error("daemon unavailable")
      })
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      await command.parseAsync(["feature/x", "--force", "--json"], { from: "user" })

      expect(worktreeModule.removeWorktree).toHaveBeenCalledWith(WORKTREE_PATH, {
        force: true,
        cwd: "/repo",
      })
      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload).toMatchObject({ removed: true, ok: false })
      expect(payload.composeDown.failed).toBe(true)
      expect(payload.cleanupErrors.join(" ")).toContain("daemon unavailable")
      expect(process.exitCode).toBe(EXIT_CODES.DOCKER_ERROR)
    })

    it("keeps the worktree when end_command fails and returns exit 1", async () => {
      vi.mocked(loaderModule.loadConfig).mockReturnValue({
        base_branch: "main",
        docker_compose_file: "compose.dev.yml",
        end_command: "./teardown.sh",
        copy_files: [],
        link_files: [],
        env: { file: [], adjust: {} },
        volumes: { exclude: [] },
      })
      vi.mocked(execModule.executeLifecycleCommand).mockImplementation(() => {
        throw new Error("boom")
      })
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
      await command.parseAsync(["feature/x", "--json"], { from: "user" })

      expect(worktreeModule.removeWorktree).not.toHaveBeenCalled()
      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload.removed).toBe(false)
      expect(payload.endCommand).toEqual({
        ran: true,
        failed: true,
        error: "End command failed: boom",
      })
      // end_command 設定時は teardown 自体が skip される
      expect(payload.composeDown.skippedReason).toBe("end-command")
      expect(payload.ok).toBe(false)
      expect(process.exitCode).toBe(EXIT_CODES.GENERAL_ERROR)
      writeSpy.mockRestore()
    })

    it("writes one contract object for an unknown branch", async () => {
      vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
        { path: "/repo", branch: "main", head: "a" },
      ])
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      await command.parseAsync(["nope", "--json"], { from: "user" })

      expect(writeSpy).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload).toMatchObject({
        branch: "nope",
        path: null,
        removed: false,
        ok: false,
        composeDown: null,
        endCommand: null,
      })
      expect(process.exitCode).toBe(EXIT_CODES.GENERAL_ERROR)
      writeSpy.mockRestore()
    })

    it("writes one contract object when repository context cannot be resolved", async () => {
      vi.mocked(repositoryModule.getRepositoryContext).mockImplementation(() => {
        throw new CLIError("Not in a git repository", EXIT_CODES.NOT_GIT_REPOSITORY)
      })
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      await command.parseAsync(["feature/x", "--json"], { from: "user" })

      expect(writeSpy).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(writeSpy.mock.calls[0][0] as string)
      expect(payload).toMatchObject({
        branch: "feature/x",
        path: null,
        removed: false,
        ok: false,
        composeDown: null,
        endCommand: null,
      })
      expect(payload.cleanupErrors).toEqual(["Not in a git repository"])
      expect(process.exitCode).toBe(EXIT_CODES.NOT_GIT_REPOSITORY)
    })
  })

  it("prints the worktree listing to stderr (not stdout) for an unknown branch", async () => {
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
