/**
 * @fileoverview prune コマンドのユニットテスト
 *
 * 孤児判定が安全である (= live worktree の volume を絶対に消さない) ことを最優先で
 * 検証する。temp volume は live worktree のものでも常に候補になること、in-use は
 * skip、--yes 無しは dry-run、--json 形 も検証。resolveComposeProjectName は実関数
 * を使う (partial mock)。
 */

import type { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EXIT_CODES } from "../../constants/index.js"
import * as loaderModule from "../../core/config/loader.js"
import * as clientModule from "../../core/docker/client.js"
import * as composeModule from "../../core/docker/compose.js"
import * as volumeModule from "../../core/docker/volume.js"
import * as repositoryModule from "../../core/git/repository.js"
import * as worktreeModule from "../../core/git/worktree.js"
import { pruneCommand } from "./prune.js"

vi.mock("../../core/config/loader.js")
vi.mock("../../core/git/repository.js")
vi.mock("../../core/git/worktree.js")
vi.mock("../../core/docker/client.js")
vi.mock("../../core/docker/volume.js")
vi.mock("../../core/docker/compose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/docker/compose.js")>()
  // keep resolveComposeProjectName REAL (it computes the project = basename here),
  // mock only the file readers
  return { ...actual, findComposeFile: vi.fn(() => null), readComposeFile: vi.fn() }
})

describe("prune command", () => {
  let command: Command
  let logSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  const logged = () => logSpy.mock.calls.map((c) => c[0]).join("\n")
  const jsonOut = () => JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""))

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    command = pruneCommand()
    vi.mocked(repositoryModule.getRepositoryContext).mockReturnValue({
      currentRoot: "/repo",
      mainRoot: "/repo",
      commonGitDir: "/git/common",
    })
    vi.mocked(loaderModule.loadConfig).mockReturnValue({
      base_branch: "main",
      docker_compose_file: "./docker-compose.yml",
      copy_files: [],
      link_files: [],
      env: { file: [], adjust: {} },
      volumes: { exclude: [] },
    })
    // one live worktree whose project (basename) is "worktree-keep"
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/repo", branch: "main", head: "a" },
      { path: "/wt/worktree-keep", branch: "feature/keep", head: "b" },
    ])
    vi.mocked(composeModule.readComposeFile).mockReturnValue({ services: {} })
    vi.mocked(volumeModule.repoVolumeLabel).mockReturnValue("repohash")
    vi.mocked(volumeModule.getVolumeRecoveryDirectory).mockReturnValue("/repo/.git/wtb/volume-recovery")
    vi.mocked(volumeModule.readVolumeRecoveryRecords).mockReturnValue([])
    vi.mocked(volumeModule.inspectVolumeOwnership).mockReturnValue({
      managed: true,
      repo: "repohash",
      temp: false,
      labels: { "wtb.managed": "true", "wtb.repo": "repohash" },
    })
    vi.mocked(volumeModule.getContainersUsingVolumeOrThrow).mockReturnValue([])
    vi.mocked(volumeModule.removeVolumeOrThrow).mockReturnValue(undefined)
    vi.mocked(volumeModule.volumeExistsOrThrow).mockReturnValue(false) // removal "succeeds"
  })

  afterEach(() => {
    logSpy.mockRestore()
    stdoutSpy.mockRestore()
  })

  it("flags orphans but NEVER the live worktree's volume (no data loss)", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([
      "worktree-keep_data", // belongs to the live worktree → must NOT be pruned
      "worktree-gone_data", // no live worktree → orphan
    ])

    await command.parseAsync([], { from: "user" }) // dry-run

    const out = logged()
    expect(out).toContain("worktree-gone_data")
    expect(out).toContain("Dry run")
    expect(out).not.toContain("worktree-keep_data")
    expect(volumeModule.removeVolumeOrThrow).not.toHaveBeenCalled()
  })

  it("holds the repository lock across destructive liveness checks and removal", async () => {
    const release = vi.fn().mockResolvedValue(undefined)
    vi.mocked(repositoryModule.acquireRepositoryLock).mockResolvedValue(release)
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([
      "worktree-gone_data",
    ])

    await command.parseAsync(["--yes"], { from: "user" })

    expect(repositoryModule.acquireRepositoryLock).toHaveBeenCalledWith({
      currentRoot: "/repo",
      mainRoot: "/repo",
      commonGitDir: "/git/common",
    })
    expect(
      vi.mocked(repositoryModule.acquireRepositoryLock).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(worktreeModule.listWorktrees).mock.invocationCallOrder[0])
    expect(volumeModule.removeVolumeOrThrow).toHaveBeenCalledWith("worktree-gone_data")
    expect(release).toHaveBeenCalledTimes(1)
    expect(release.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(volumeModule.removeVolumeOrThrow).mock.invocationCallOrder[0]
    )
  })

  it("does not acquire the repository lock for a read-only prune preview", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([
      "worktree-gone_data",
    ])

    await command.parseAsync([], { from: "user" })

    expect(repositoryModule.acquireRepositoryLock).not.toHaveBeenCalled()
  })

  it("does not confuse project-name prefixes (worktree-keep vs worktree-keepx)", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue(["worktree-keepx_data"])
    await command.parseAsync([], { from: "user" })
    // worktree-keepx_data does NOT belong to worktree-keep (the `_` separator guards it)
    expect(logged()).toContain("worktree-keepx_data")
  })

  it("always flags leftover temp volumes even for a live worktree", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([
      "worktree-keep_data__wtbtmp_abc123", // temp of a LIVE worktree → still a leak
    ])
    vi.mocked(volumeModule.inspectVolumeOwnership).mockReturnValue({
      managed: true,
      repo: "repohash",
      project: "worktree-keep",
      branch: "feature/keep",
      temp: true,
      labels: { "wtb.temp": "true" },
    })
    await command.parseAsync([], { from: "user" })
    expect(logged()).toContain("leftover temp volume")
  })

  it("does not classify a new-label non-temp volume by a temp-like name", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([
      "worktree-keep__wtbtmp_feature_data",
    ])
    vi.mocked(volumeModule.inspectVolumeOwnership).mockReturnValue({
      managed: true,
      repo: "repohash",
      project: "worktree-keep",
      branch: "feature/keep",
      temp: false,
      labels: {
        "wtb.managed": "true",
        "wtb.repo": "repohash",
        "wtb.project": "worktree-keep",
        "wtb.branch": "feature/keep",
      },
    })

    await command.parseAsync(["--json"], { from: "user" })

    expect(jsonOut().candidates).toEqual([])
  })

  it("--yes removes the orphans and reports the count", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue(["worktree-gone_data"])
    await command.parseAsync(["--yes"], { from: "user" })
    expect(volumeModule.removeVolumeOrThrow).toHaveBeenCalledWith("worktree-gone_data")
    expect(logged()).toContain("Pruned 1 volume")
  })

  it("skips a candidate that is currently in use by a container", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue(["worktree-gone_data"])
    vi.mocked(volumeModule.getContainersUsingVolumeOrThrow).mockReturnValue(["some-container"])
    await command.parseAsync(["--yes"], { from: "user" })
    expect(volumeModule.removeVolumeOrThrow).not.toHaveBeenCalled()
    expect(logged()).toContain("in use by some-container")
  })

  it("reports nothing to do when there are no candidates", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue(["worktree-keep_data"])
    await command.parseAsync([], { from: "user" })
    expect(logged()).toContain("No orphaned or leftover")
    expect(volumeModule.removeVolumeOrThrow).not.toHaveBeenCalled()
  })

  it("--json emits a machine-readable summary", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([
      "worktree-keep_data",
      "worktree-gone_data",
    ])
    await command.parseAsync(["--json"], { from: "user" })
    const j = jsonOut()
    expect(j.dryRun).toBe(true)
    expect(j.candidates).toHaveLength(1)
    expect(j.candidates[0]).toMatchObject({ name: "worktree-gone_data", reason: "orphan" })
    expect(j.removed).toEqual([])
  })

  it("refuses to prune (and deletes nothing) if worktree enumeration returns empty", async () => {
    // a git error → listWorktrees() returns [] → without the guard EVERY managed
    // volume would be treated as orphaned. The guard must abort with exit 1.
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([])
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([
      "worktree-keep_data",
      "worktree-gone_data",
    ])
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await expect(command.parseAsync(["--yes"], { from: "user" })).rejects.toThrow("exit")
    expect(exit).toHaveBeenCalledWith(1)
    expect(volumeModule.removeVolumeOrThrow).not.toHaveBeenCalled()
    exit.mockRestore()
  })

  it("--json --yes reports removed volumes", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue(["worktree-gone_data"])
    await command.parseAsync(["--json", "--yes"], { from: "user" })
    const j = jsonOut()
    expect(j.dryRun).toBe(false)
    expect(j.removed).toEqual(["worktree-gone_data"])
    expect(j.failed).toEqual([])
  })

  it("--json exposes inUse and the blocking container names via inUseBy", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue(["worktree-gone_data"])
    vi.mocked(volumeModule.getContainersUsingVolumeOrThrow).mockReturnValue(["blocking-container"])
    await command.parseAsync(["--json"], { from: "user" })
    const j = jsonOut()
    expect(j.candidates[0]).toMatchObject({
      name: "worktree-gone_data",
      inUse: true,
      inUseBy: ["blocking-container"],
    })
  })

  it("--yes exits with DOCKER_ERROR when a removal fails", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue(["worktree-gone_data"])
    vi.mocked(volumeModule.volumeExistsOrThrow).mockReturnValue(true) // still exists → removal failed
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await expect(command.parseAsync(["--yes"], { from: "user" })).rejects.toThrow("exit")
    expect(exit).toHaveBeenCalledWith(EXIT_CODES.DOCKER_ERROR)
    // サマリ出力 (Failed to remove ...) は exit より先に出ていること
    expect(logged()).toContain("Failed to remove worktree-gone_data")
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to remove 1 volume(s): worktree-gone_data")
    )
    exit.mockRestore()
    errorSpy.mockRestore()
  })

  it("--json --yes lists failures in failed[] and sets exitCode DOCKER_ERROR (JSON stays intact)", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue(["worktree-gone_data"])
    vi.mocked(volumeModule.volumeExistsOrThrow).mockReturnValue(true) // still exists → removal failed
    const previousExitCode = process.exitCode

    await command.parseAsync(["--json", "--yes"], { from: "user" })

    const j = jsonOut()
    expect(j.removed).toEqual([])
    expect(j.failed).toEqual(["worktree-gone_data"])
    expect(process.exitCode).toBe(EXIT_CODES.DOCKER_ERROR)
    process.exitCode = previousExitCode
  })

  it("revalidates ownership immediately before deletion", async () => {
    const initial = {
      managed: true,
      repo: "repohash",
      project: "worktree-gone",
      branch: "feature/gone",
      temp: false,
      labels: {
        "wtb.managed": "true",
        "wtb.repo": "repohash",
        "wtb.project": "worktree-gone",
        "wtb.branch": "feature/gone",
      },
    }
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([
      "worktree-gone_data",
    ])
    vi.mocked(volumeModule.inspectVolumeOwnership)
      .mockReturnValueOnce(initial)
      .mockReturnValueOnce({
        ...initial,
        branch: "feature/reassigned",
        labels: { ...initial.labels, "wtb.branch": "feature/reassigned" },
      })
    const previousExitCode = process.exitCode

    await command.parseAsync(["--json", "--yes"], { from: "user" })

    expect(volumeModule.removeVolumeOrThrow).not.toHaveBeenCalled()
    expect(jsonOut().failed).toEqual(["worktree-gone_data"])
    expect(process.exitCode).toBe(EXIT_CODES.DOCKER_ERROR)
    process.exitCode = previousExitCode
  })

  it("keeps new volumes when either project or branch is live and uses prefix only for legacy", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([
      "unrelated-looking-name",
      "worktree-keep_branch-mismatch",
      "project-mismatch_branch-live",
      "fully-orphaned",
      "worktree-keep_legacy",
    ])
    vi.mocked(volumeModule.inspectVolumeOwnership).mockImplementation((name) => {
      if (name === "unrelated-looking-name") {
        return {
          managed: true,
          repo: "repohash",
          project: "worktree-keep",
          branch: "feature/keep",
          temp: false,
          labels: {},
        }
      }
      if (name === "worktree-keep_branch-mismatch") {
        return {
          managed: true,
          repo: "repohash",
          project: "worktree-keep",
          branch: "feature/gone",
          temp: false,
          labels: {},
        }
      }
      if (name === "project-mismatch_branch-live") {
        return {
          managed: true,
          repo: "repohash",
          project: "renamed-project",
          branch: "feature/keep",
          temp: false,
          labels: {},
        }
      }
      if (name === "fully-orphaned") {
        return {
          managed: true,
          repo: "repohash",
          project: "gone-project",
          branch: "feature/gone",
          temp: false,
          labels: {},
        }
      }
      return { managed: true, repo: "repohash", temp: false, labels: {} }
    })

    await command.parseAsync(["--json"], { from: "user" })

    expect(jsonOut().candidates.map((entry: { name: string }) => entry.name)).toEqual([
      "fully-orphaned",
    ])
  })

  it("resolves only the main config's exact compose path for every worktree", async () => {
    vi.mocked(loaderModule.loadConfig).mockReturnValue({
      base_branch: "main",
      docker_compose_file: "./ops/custom-compose.yml",
      copy_files: [],
      link_files: [],
      env: { file: [], adjust: {} },
      volumes: { exclude: [] },
    })
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([])

    await command.parseAsync(["--json"], { from: "user" })

    expect(composeModule.readComposeFile).toHaveBeenNthCalledWith(
      1,
      "/repo/ops/custom-compose.yml"
    )
    expect(composeModule.readComposeFile).toHaveBeenNthCalledWith(
      2,
      "/wt/worktree-keep/ops/custom-compose.yml"
    )
    expect(repositoryModule.getRepositoryContext).toHaveBeenCalled()
    expect(volumeModule.getVolumeRecoveryDirectory).toHaveBeenCalledWith("/git/common")
    expect(loaderModule.loadConfig).toHaveBeenCalledWith("/repo")
    expect(worktreeModule.listWorktrees).toHaveBeenCalledWith("/repo")
  })

  it("protects an exact external volume referenced only by a stopped linked worktree", async () => {
    const externalName = "shared-live-data"
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([
      externalName,
    ])
    vi.mocked(composeModule.readComposeFile).mockImplementation((composePath) =>
      composePath.startsWith("/wt/worktree-keep/")
        ? {
            services: {},
            volumes: {
              shared: {
                external: { name: `\${WTB_PRUNE_SHARED:-shared-live-data}` },
              },
            },
          }
        : { services: {} }
    )
    vi.mocked(volumeModule.resolveVolumeName).mockReturnValue({
      name: `\${WTB_PRUNE_SHARED:-shared-live-data}`,
      external: true,
    })
    vi.mocked(volumeModule.inspectVolumeOwnership).mockReturnValue({
      managed: true,
      repo: "repohash",
      project: "deleted-project",
      branch: "feature/deleted",
      temp: false,
      labels: {},
    })

    await command.parseAsync(["--json", "--yes"], { from: "user" })

    expect(jsonOut().candidates).toEqual([])
    expect(volumeModule.removeVolumeOrThrow).not.toHaveBeenCalled()
  })

  it("a transient external-name override only widens protection", async () => {
    const envKey = "WTB_PRUNE_SHARED"
    const previous = process.env[envKey]
    process.env[envKey] = "temporary-live-data"
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([
      "shared-live-data",
      "temporary-live-data",
    ])
    vi.mocked(composeModule.readComposeFile).mockReturnValue({
      services: {},
      volumes: { shared: { external: true, name: `\${${envKey}:-shared-live-data}` } },
    })
    vi.mocked(volumeModule.resolveVolumeName).mockReturnValue({
      name: `\${${envKey}:-shared-live-data}`,
      external: true,
    })
    vi.mocked(volumeModule.inspectVolumeOwnership).mockReturnValue({
      managed: true,
      repo: "repohash",
      project: "deleted-project",
      branch: "feature/deleted",
      temp: false,
      labels: {},
    })

    try {
      await command.parseAsync(["--json", "--yes"], { from: "user" })
      expect(jsonOut().candidates).toEqual([])
      expect(volumeModule.removeVolumeOrThrow).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env[envKey]
      else process.env[envKey] = previous
    }
  })

  it("a transient COMPOSE_PROJECT_NAME cannot orphan legacy project-prefix volumes", async () => {
    const previous = process.env.COMPOSE_PROJECT_NAME
    process.env.COMPOSE_PROJECT_NAME = "temporary"
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([
      "worktree-keep_data",
    ])

    try {
      await command.parseAsync(["--json", "--yes"], { from: "user" })
      expect(jsonOut().candidates).toEqual([])
      expect(volumeModule.removeVolumeOrThrow).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.COMPOSE_PROJECT_NAME
      else process.env.COMPOSE_PROJECT_NAME = previous
    }
  })

  it("fails closed when a live worktree's external volume name cannot be interpolated", async () => {
    const envKey = "WTB_PRUNE_TEST_REQUIRED_VOLUME_NAME"
    const previous = process.env[envKey]
    delete process.env[envKey]
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([
      "would-be-deleted",
    ])
    vi.mocked(composeModule.readComposeFile).mockReturnValue({
      services: {},
      volumes: {
        shared: {
          external: true,
          name: `\${${envKey}:?required}`,
        },
      },
    })
    vi.mocked(volumeModule.resolveVolumeName).mockReturnValue({
      name: `\${${envKey}:?required}`,
      external: true,
    })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    try {
      await expect(command.parseAsync(["--yes"], { from: "user" })).rejects.toThrow(
        "exit"
      )
      expect(exit).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
      expect(volumeModule.removeVolumeOrThrow).not.toHaveBeenCalled()
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("external volume 'shared' has an unresolved name")
      )
    } finally {
      if (previous === undefined) delete process.env[envKey]
      else process.env[envKey] = previous
      exit.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it("protects a temp volume referenced by a recovery record and exposes it in JSON", async () => {
    const tempVolume = "worktree-gone_data__wtbtmp_recover"
    const recovery = {
      path: "/repo/.git/wtb/volume-recovery/recover.json",
      record: {
        version: 1 as const,
        id: "recover",
        createdAt: "2026-07-10T00:00:00.000Z",
        sourceVolume: "source_data",
        targetVolume: "worktree-gone_data",
        tempVolume,
        sourceBytes: 10,
        stagedBytes: 10,
        ownership: { repo: "repohash", project: "worktree-gone", branch: "feature/gone" },
      },
    }
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([tempVolume])
    vi.mocked(volumeModule.inspectVolumeOwnership).mockReturnValue({
      managed: true,
      repo: "repohash",
      project: "worktree-gone",
      branch: "feature/gone",
      temp: true,
      labels: {},
    })
    vi.mocked(volumeModule.readVolumeRecoveryRecords).mockReturnValue([recovery])

    await command.parseAsync(["--json"], { from: "user" })

    const payload = jsonOut()
    expect(payload.protected).toEqual([tempVolume])
    expect(payload.candidates).toEqual([])
    expect(volumeModule.removeVolumeOrThrow).not.toHaveBeenCalled()
  })

  it("protects a recovery-record volume even if its temp label was lost", async () => {
    const tempVolume = "worktree-gone_data__wtbtmp_recover"
    const recovery = {
      path: "/repo/.git/wtb/volume-recovery/recover.json",
      record: {
        version: 1 as const,
        id: "recover",
        createdAt: "2026-07-10T00:00:00.000Z",
        sourceVolume: "source_data",
        targetVolume: "worktree-gone_data",
        tempVolume,
        sourceBytes: 10,
        stagedBytes: 10,
        ownership: { repo: "repohash", project: "worktree-gone", branch: "feature/gone" },
      },
    }
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([tempVolume])
    vi.mocked(volumeModule.inspectVolumeOwnership).mockReturnValue({
      managed: true,
      repo: "repohash",
      project: "worktree-gone",
      branch: "feature/gone",
      temp: false,
      labels: {
        "wtb.managed": "true",
        "wtb.repo": "repohash",
        "wtb.project": "worktree-gone",
        "wtb.branch": "feature/gone",
      },
    })
    vi.mocked(volumeModule.readVolumeRecoveryRecords).mockReturnValue([recovery])

    await command.parseAsync(["--json", "--yes"], { from: "user" })

    expect(jsonOut()).toMatchObject({ candidates: [], protected: [tempVolume], removed: [] })
    expect(volumeModule.removeVolumeOrThrow).not.toHaveBeenCalled()
  })

  it("requires --yes with --discard-recovery before touching Docker", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await expect(
      command.parseAsync(["--discard-recovery"], { from: "user" })
    ).rejects.toThrow("exit")

    expect(exit).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
    expect(clientModule.getWtbManagedVolumeNamesOrThrow).not.toHaveBeenCalled()
    expect(volumeModule.removeVolumeOrThrow).not.toHaveBeenCalled()
    exit.mockRestore()
    errorSpy.mockRestore()
  })

  it("--yes --discard-recovery removes the protected temp then its record", async () => {
    const tempVolume = "worktree-gone_data__wtbtmp_recover"
    const recovery = {
      path: "/repo/.git/wtb/volume-recovery/recover.json",
      record: {
        version: 1 as const,
        id: "recover",
        createdAt: "2026-07-10T00:00:00.000Z",
        sourceVolume: "source_data",
        targetVolume: "worktree-gone_data",
        tempVolume,
        sourceBytes: 10,
        stagedBytes: 10,
        ownership: { repo: "repohash", project: "worktree-gone", branch: "feature/gone" },
      },
    }
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([tempVolume])
    vi.mocked(volumeModule.inspectVolumeOwnership).mockReturnValue({
      managed: true,
      repo: "repohash",
      project: "worktree-gone",
      branch: "feature/gone",
      temp: true,
      labels: {},
    })
    vi.mocked(volumeModule.readVolumeRecoveryRecords).mockReturnValue([recovery])
    vi.mocked(volumeModule.volumeExistsOrThrow)
      .mockReturnValueOnce(true)
      .mockReturnValue(false)

    await command.parseAsync(["--json", "--yes", "--discard-recovery"], { from: "user" })

    expect(volumeModule.removeVolumeOrThrow).toHaveBeenCalledWith(tempVolume)
    expect(volumeModule.removeVolumeRecoveryRecord).toHaveBeenCalledWith(recovery.path)
    expect(jsonOut()).toMatchObject({ protected: [], removed: [tempVolume], failed: [] })
  })

  it("--yes --discard-recovery removes a stale record whose temp is already absent", async () => {
    const recovery = {
      path: "/repo/.git/wtb/volume-recovery/stale.json",
      record: {
        version: 1 as const,
        id: "stale",
        createdAt: "2026-07-10T00:00:00.000Z",
        sourceVolume: "source_data",
        targetVolume: "worktree-gone_data",
        tempVolume: "worktree-gone_data__wtbtmp_1_2_stale",
        sourceBytes: 10,
        stagedBytes: 10,
        ownership: { repo: "repohash", project: "worktree-gone", branch: "feature/gone" },
      },
    }
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([])
    vi.mocked(volumeModule.readVolumeRecoveryRecords).mockReturnValue([recovery])
    vi.mocked(volumeModule.volumeExistsOrThrow).mockReturnValue(false)

    await command.parseAsync(["--json", "--yes", "--discard-recovery"], { from: "user" })

    expect(volumeModule.removeVolumeRecoveryRecord).toHaveBeenCalledWith(recovery.path)
    expect(jsonOut()).toMatchObject({ protected: [], removed: [], failed: [] })
  })

  it("refuses to discard a recovery temp whose ownership changed", async () => {
    const tempVolume = "worktree-gone_data__wtbtmp_recover"
    const recovery = {
      path: "/repo/.git/wtb/volume-recovery/recover.json",
      record: {
        version: 1 as const,
        id: "recover",
        createdAt: "2026-07-10T00:00:00.000Z",
        sourceVolume: "source_data",
        targetVolume: "worktree-gone_data",
        tempVolume,
        sourceBytes: 10,
        stagedBytes: 10,
        ownership: { repo: "repohash", project: "worktree-gone", branch: "feature/gone" },
      },
    }
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([tempVolume])
    vi.mocked(volumeModule.inspectVolumeOwnership).mockReturnValue({
      managed: true,
      repo: "repohash",
      project: "worktree-gone",
      branch: "feature/reassigned",
      temp: true,
      labels: {
        "wtb.managed": "true",
        "wtb.repo": "repohash",
        "wtb.project": "worktree-gone",
        "wtb.branch": "feature/reassigned",
        "wtb.temp": "true",
      },
    })
    vi.mocked(volumeModule.readVolumeRecoveryRecords).mockReturnValue([recovery])
    vi.mocked(volumeModule.volumeExistsOrThrow).mockReturnValue(true)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await expect(
      command.parseAsync(["--yes", "--discard-recovery"], { from: "user" })
    ).rejects.toThrow("exit")

    expect(exit).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
    expect(volumeModule.removeVolumeOrThrow).not.toHaveBeenCalled()
    exit.mockRestore()
    errorSpy.mockRestore()
  })

  it("fails closed before deletion when an exact Compose file cannot be read", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([
      "worktree-gone_data",
    ])
    vi.mocked(composeModule.readComposeFile).mockImplementation(() => {
      throw new Error("ENOENT")
    })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await expect(command.parseAsync(["--yes"], { from: "user" })).rejects.toThrow("exit")

    expect(exit).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
    expect(volumeModule.removeVolumeOrThrow).not.toHaveBeenCalled()
    exit.mockRestore()
    errorSpy.mockRestore()
  })

  it("fails closed when a recovery record is corrupt", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNamesOrThrow).mockReturnValue([
      "worktree-gone_data__wtbtmp_unknown",
    ])
    vi.mocked(volumeModule.readVolumeRecoveryRecords).mockImplementation(() => {
      throw new Error("Invalid volume recovery record")
    })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await expect(command.parseAsync(["--yes"], { from: "user" })).rejects.toThrow("exit")

    expect(exit).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
    expect(volumeModule.removeVolumeOrThrow).not.toHaveBeenCalled()
    exit.mockRestore()
    errorSpy.mockRestore()
  })
})
