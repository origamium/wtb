/**
 * @fileoverview setupVolumeCopy オーケストレーションのユニットテスト
 *
 * setupVolumeCopy は create.ts の phase 6.5 を担当する 130+ LoC の関数で、
 * 自動 e2e の網にかからない skip 経路 (source 不在 / live source / target populated /
 * copy 失敗) のレグレッションを守るためにテストする。
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
import type { ComposeConfig, WtbConfig } from "../../types/index.js"
import { createCommand, setupVolumeCopy } from "./create.js"

vi.mock("../../core/docker/compose.js")
vi.mock("../../core/docker/volume.js")
vi.mock("../../core/docker/client.js")
vi.mock("../../core/config/loader.js")
vi.mock("../../core/git/repository.js")
vi.mock("../../core/git/worktree.js")
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  // create.ts also imports lstatSync/readlinkSync/statSync/symlinkSync —
  // not used by setupVolumeCopy but must be exported by the mock.
  lstatSync: vi.fn(),
  readlinkSync: vi.fn(),
  statSync: vi.fn(),
  symlinkSync: vi.fn(),
}))

const baseConfig = (overrides: Partial<WtbConfig> = {}): WtbConfig => ({
  base_branch: "main",
  docker_compose_file: "./docker-compose.yml",
  copy_files: [],
  link_files: [],
  env: { file: ["./.env"], adjust: {} },
  volumes: { exclude: [] },
  ...overrides,
})

const composeFixture = (volumes?: Record<string, unknown>): ComposeConfig => ({
  services: { db: { image: "postgres" } },
  ...(volumes !== undefined && { volumes: volumes as ComposeConfig["volumes"] }),
})

describe("setupVolumeCopy orchestration", () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    // clearAllMocks resets call history but NOT implementations set via
    // mockImplementation in a prior test — reset compose stop/start/up to no-op
    // defaults so a throwing impl from one test doesn't leak into the next.
    vi.mocked(composeModule.composeStop).mockReset()
    vi.mocked(composeModule.composeStart).mockReset()
    vi.mocked(composeModule.composeUp).mockReset()
    // Default: rich compose with a single non-external named volume.
    vi.mocked(composeModule.readComposeFile).mockReturnValue(
      composeFixture({ postgres_data: null })
    )
    vi.mocked(composeModule.resolveComposeProjectName).mockImplementation((_cfg, dir) =>
      dir.endsWith("worktree") ? "target_proj" : "source_proj"
    )
    vi.mocked(volumeModule.discoverCloneableVolumes).mockImplementation((cfg, exclude) =>
      Object.keys(cfg.volumes ?? {}).filter((k) => !(exclude ?? []).includes(k))
    )
    vi.mocked(volumeModule.resolveVolumeName).mockImplementation((_cfg, key, project) => ({
      name: `${project}_${key}`,
      external: false,
    }))
    vi.mocked(volumeModule.volumeExists).mockReturnValue(true)
    vi.mocked(volumeModule.getVolumeSize).mockReturnValue(0)
    vi.mocked(volumeModule.getContainersUsingVolume).mockReturnValue([])
    vi.mocked(volumeModule.getContainersUsingVolumeWithProject).mockReturnValue([])
    vi.mocked(volumeModule.copyVolume).mockResolvedValue(undefined)
  })

  /** holders を sourceProject 所属として返す helper (planVolumeClones 用)。 */
  const ownHolders = (...names: string[]) => names.map((name) => ({ name, project: "source_proj" }))

  afterEach(() => {
    logSpy.mockRestore()
  })

  const run = (force = false, config: WtbConfig = baseConfig(), stop?: boolean) =>
    setupVolumeCopy("/repo", "/repo/worktree", config, { force, stop })

  it("returns silently when docker_compose_file is empty", async () => {
    await run(false, baseConfig({ docker_compose_file: "" }))
    expect(volumeModule.copyVolume).not.toHaveBeenCalled()
    expect(logSpy).not.toHaveBeenCalled()
  })

  it("returns silently when discoverCloneableVolumes is empty (no volumes / all external / all excluded)", async () => {
    vi.mocked(volumeModule.discoverCloneableVolumes).mockReturnValue([])
    await run()
    expect(volumeModule.copyVolume).not.toHaveBeenCalled()
    // The "Cloning Docker volumes..." header is NOT printed in this case.
    expect(logSpy).not.toHaveBeenCalled()
  })

  it("skips a volume whose source does not exist (first-time setup)", async () => {
    vi.mocked(volumeModule.volumeExists).mockImplementation(
      (name) => name !== "source_proj_postgres_data"
    )
    await run()
    expect(volumeModule.copyVolume).not.toHaveBeenCalled()
    const messages = logSpy.mock.calls.map((c) => c[0]).join("\n")
    expect(messages).toContain("source volume does not exist yet")
    expect(messages).toContain("0 volume(s) cloned, 1 skipped")
  })

  it("stops the source stack, clones, then restarts when source is running (default)", async () => {
    // Plan step sees a running container owned by sourceProject → clone-after-stop.
    // After composeStop the post-stop re-check (getContainersUsingVolume) is empty,
    // so the clone proceeds.
    vi.mocked(volumeModule.getContainersUsingVolumeWithProject).mockReturnValue(
      ownHolders("pg-main")
    )
    vi.mocked(volumeModule.getContainersUsingVolume).mockReturnValue([])
    await run(false)
    // Default (no --force, no --no-stop): stop-then-copy makes the running DB safe to clone.
    expect(composeModule.composeStop).toHaveBeenCalledTimes(1)
    expect(volumeModule.copyVolume).toHaveBeenCalledTimes(1)
    expect(composeModule.composeStart).toHaveBeenCalledTimes(1)
    // The SOURCE stack (project + compose path + cwd), never the target, is acted on.
    expect(composeModule.composeStop).toHaveBeenCalledWith(
      "/repo/docker-compose.yml",
      "source_proj",
      "/repo"
    )
    expect(composeModule.composeStart).toHaveBeenCalledWith(
      "/repo/docker-compose.yml",
      "source_proj",
      "/repo"
    )
    // Ordering: stop → copy → restart.
    const stopOrder = vi.mocked(composeModule.composeStop).mock.invocationCallOrder[0]
    const copyOrder = vi.mocked(volumeModule.copyVolume).mock.invocationCallOrder[0]
    const startOrder = vi.mocked(composeModule.composeStart).mock.invocationCallOrder[0]
    expect(stopOrder).toBeLessThan(copyOrder)
    expect(copyOrder).toBeLessThan(startOrder)
    const messages = logSpy.mock.calls.map((c) => c[0]).join("\n")
    expect(messages).toContain("stopping it to clone volumes safely")
    expect(messages).toContain("Source stack restarted")
  })

  it("restarts the source stack even when copyVolume throws (crash-safe finally)", async () => {
    vi.mocked(volumeModule.getContainersUsingVolumeWithProject).mockReturnValue(
      ownHolders("pg-main")
    )
    vi.mocked(volumeModule.getContainersUsingVolume).mockReturnValue([])
    vi.mocked(volumeModule.copyVolume).mockRejectedValue(new Error("rsync exploded"))
    await run(false)
    expect(composeModule.composeStop).toHaveBeenCalledTimes(1)
    // The finally block must bring the source stack back up despite the failure.
    expect(composeModule.composeStart).toHaveBeenCalledTimes(1)
    const messages = logSpy.mock.calls.map((c) => c[0]).join("\n")
    expect(messages).toContain("Failed to clone postgres_data")
    expect(messages).toContain("Source stack restarted")
  })

  it("skips (and still restarts) a volume still in use after stopping the stack (post-stop recheck)", async () => {
    // Plan classifies it as clone-after-stop (own-project holder), so we stop. But the
    // post-stop re-check still finds a holder (e.g. a stray container our composeStop
    // didn't catch) — wtb must NOT live-copy it; it must skip, but still restart our stack.
    vi.mocked(volumeModule.getContainersUsingVolumeWithProject).mockReturnValue(
      ownHolders("pg-main")
    )
    vi.mocked(volumeModule.getContainersUsingVolume).mockReturnValue(["pg-main"])
    await run(false)
    expect(composeModule.composeStop).toHaveBeenCalledTimes(1)
    expect(volumeModule.copyVolume).not.toHaveBeenCalled()
    expect(composeModule.composeStart).toHaveBeenCalledTimes(1)
    const messages = logSpy.mock.calls.map((c) => c[0]).join("\n")
    expect(messages).toContain("after stopping")
  })

  it("foreign-project holder → skip WITHOUT stopping the source stack", async () => {
    // The volume is held by ANOTHER Compose project. Stopping OUR source stack would
    // not free it, so wtb must skip the volume and never call composeStop.
    vi.mocked(volumeModule.getContainersUsingVolumeWithProject).mockReturnValue([
      { name: "other-proj-db", project: "other_proj" },
    ])
    await run(false)
    expect(composeModule.composeStop).not.toHaveBeenCalled()
    expect(composeModule.composeStart).not.toHaveBeenCalled()
    expect(volumeModule.copyVolume).not.toHaveBeenCalled()
    const messages = logSpy.mock.calls.map((c) => c[0]).join("\n")
    expect(messages).toContain("another Compose project 'other_proj'")
  })

  it("mixed source-owned and foreign holders → clone-after-stop the owned, skip the foreign", async () => {
    vi.mocked(composeModule.readComposeFile).mockReturnValue(
      composeFixture({ postgres_data: null, shared_cache: null })
    )
    // postgres_data held by sourceProject (clone-after-stop); shared_cache held by foreign.
    vi.mocked(volumeModule.getContainersUsingVolumeWithProject).mockImplementation((name) =>
      name === "source_proj_postgres_data"
        ? ownHolders("pg-main")
        : [{ name: "other-db", project: "other_proj" }]
    )
    vi.mocked(volumeModule.getContainersUsingVolume).mockReturnValue([]) // post-stop recheck clean
    const result = await run(false)
    expect(composeModule.composeStop).toHaveBeenCalledTimes(1)
    expect(result.cloned).toEqual(["postgres_data"])
    expect(result.skipped).toEqual([
      {
        name: "shared_cache",
        reason:
          "held by another Compose project 'other_proj' — stopping the source stack won't free it",
      },
    ])
  })

  it("when composeStop throws, falls back to per-volume skip and does NOT restart", async () => {
    vi.mocked(volumeModule.getContainersUsingVolumeWithProject).mockReturnValue(
      ownHolders("pg-main")
    )
    vi.mocked(composeModule.composeStop).mockImplementation(() => {
      throw new Error("docker daemon down")
    })
    const result = await run(false)
    expect(volumeModule.copyVolume).not.toHaveBeenCalled()
    // Nothing was stopped, so nothing must be (re)started.
    expect(composeModule.composeStart).not.toHaveBeenCalled()
    expect(result.skipped).toEqual([
      {
        name: "postgres_data",
        reason: "could not stop source stack to clone a live source volume",
      },
    ])
    const messages = logSpy.mock.calls.map((c) => c[0]).join("\n")
    expect(messages).toContain("Could not stop source stack")
  })

  it("with --no-stop, skips a running source volume (preserves old behavior)", async () => {
    vi.mocked(volumeModule.getContainersUsingVolumeWithProject).mockReturnValue(
      ownHolders("pg-main")
    )
    await run(false, baseConfig(), false)
    expect(composeModule.composeStop).not.toHaveBeenCalled()
    expect(volumeModule.copyVolume).not.toHaveBeenCalled()
    const messages = logSpy.mock.calls.map((c) => c[0]).join("\n")
    expect(messages).toContain("--no-stop")
  })

  it("does not stop the stack when no source volume is in use", async () => {
    // Default mock: getContainersUsingVolumeWithProject returns [] — nothing running.
    await run(false)
    expect(composeModule.composeStop).not.toHaveBeenCalled()
    expect(composeModule.composeStart).not.toHaveBeenCalled()
    expect(volumeModule.copyVolume).toHaveBeenCalledTimes(1)
  })

  it("clones live without stopping when force=true (live-copy path preserved)", async () => {
    vi.mocked(volumeModule.getContainersUsingVolumeWithProject).mockReturnValue(
      ownHolders("pg-main")
    )
    await run(true)
    expect(composeModule.composeStop).not.toHaveBeenCalled()
    expect(volumeModule.copyVolume).toHaveBeenCalledTimes(1)
  })

  it("skips when target volume already has data and force=false", async () => {
    vi.mocked(volumeModule.getVolumeSize).mockImplementation((name) =>
      name === "target_proj_postgres_data" ? 1024 : 0
    )
    await run(false)
    expect(volumeModule.copyVolume).not.toHaveBeenCalled()
    const messages = logSpy.mock.calls.map((c) => c[0]).join("\n")
    expect(messages).toContain("target volume already has data")
  })

  it("skips when target volume size cannot be determined and force=false", async () => {
    // getVolumeSize returns null on a probe failure — must NOT be treated as empty
    // (which would silently overwrite). Skip instead.
    vi.mocked(volumeModule.getVolumeSize).mockImplementation((name) =>
      name === "target_proj_postgres_data" ? null : 0
    )
    await run(false)
    expect(volumeModule.copyVolume).not.toHaveBeenCalled()
    const messages = logSpy.mock.calls.map((c) => c[0]).join("\n")
    expect(messages).toContain("target volume size could not be determined")
  })

  it("overwrites when target size is unknown and force=true", async () => {
    vi.mocked(volumeModule.getVolumeSize).mockImplementation((name) =>
      name === "target_proj_postgres_data" ? null : 0
    )
    await run(true)
    expect(volumeModule.copyVolume).toHaveBeenCalledWith(
      "source_proj_postgres_data",
      "target_proj_postgres_data",
      expect.objectContaining({ clearTarget: true })
    )
  })

  it("clears target and clones when target has data and force=true", async () => {
    vi.mocked(volumeModule.getVolumeSize).mockImplementation((name) =>
      name === "target_proj_postgres_data" ? 1024 : 0
    )
    await run(true)
    expect(volumeModule.copyVolume).toHaveBeenCalledTimes(1)
    // Verify clearTarget=true is passed so the cp fallback also overwrites
    expect(volumeModule.copyVolume).toHaveBeenCalledWith(
      "source_proj_postgres_data",
      "target_proj_postgres_data",
      expect.objectContaining({ clearTarget: true })
    )
  })

  it("clones with clearTarget=false when target is empty/absent", async () => {
    // default mocks: volumeExists=true, getVolumeSize=0 — empty target
    await run(false)
    expect(volumeModule.copyVolume).toHaveBeenCalledWith(
      "source_proj_postgres_data",
      "target_proj_postgres_data",
      expect.objectContaining({ clearTarget: false })
    )
  })

  it("reports failure when copyVolume throws (counted as failed, not skipped)", async () => {
    vi.mocked(volumeModule.copyVolume).mockRejectedValue(new Error("rsync exploded"))
    const result = await run()
    // No container running → stack never stopped → restart must not fire.
    expect(composeModule.composeStart).not.toHaveBeenCalled()
    const messages = logSpy.mock.calls.map((c) => c[0]).join("\n")
    expect(messages).toContain("Failed to clone postgres_data")
    expect(messages).toContain("rsync exploded")
    expect(messages).toContain("0 volume(s) cloned, 0 skipped, 1 failed")
    // The parsable result distinguishes a real failure from an intentional skip,
    // so the create banner can be qualified instead of reporting clean success.
    expect(result).toEqual({
      cloned: [],
      skipped: [],
      failed: [{ name: "postgres_data", error: "rsync exploded" }],
    })
  })

  it("returns per-volume entries distinguishing cloned / skipped / failed (counts derivable via length)", async () => {
    // postgres_data clones; cache's source is absent (intentional skip).
    vi.mocked(composeModule.readComposeFile).mockReturnValue(
      composeFixture({ postgres_data: null, cache: null })
    )
    vi.mocked(volumeModule.volumeExists).mockImplementation((name) => name !== "source_proj_cache")
    const result = await run()
    expect(result).toEqual({
      cloned: ["postgres_data"],
      skipped: [{ name: "cache", reason: "source volume does not exist yet" }],
      failed: [],
    })
  })

  it("records a per-volume skip reason when the target volume already has data", async () => {
    vi.mocked(volumeModule.getVolumeSize).mockImplementation((name) =>
      name === "target_proj_postgres_data" ? 1024 : 0
    )
    const result = await run(false)
    expect(result.skipped).toEqual([
      { name: "postgres_data", reason: "target volume already has data" },
    ])
    expect(result.cloned).toEqual([])
    expect(result.failed).toEqual([])
  })

  it("records the --no-stop skip reason for an in-use source volume", async () => {
    vi.mocked(volumeModule.getContainersUsingVolumeWithProject).mockReturnValue(
      ownHolders("pg-main")
    )
    const result = await run(false, baseConfig(), false)
    expect(result.skipped).toEqual([
      {
        name: "postgres_data",
        reason: "source volume is in use by a running container (--no-stop)",
      },
    ])
  })

  it("respects volumes.exclude", async () => {
    vi.mocked(composeModule.readComposeFile).mockReturnValue(
      composeFixture({ postgres_data: null, cache: null })
    )
    await run(false, baseConfig({ volumes: { exclude: ["cache"] } }))
    // discoverCloneableVolumes mock filters by exclude; only postgres_data should be passed forward
    expect(volumeModule.copyVolume).toHaveBeenCalledTimes(1)
    expect(volumeModule.copyVolume).toHaveBeenCalledWith(
      "source_proj_postgres_data",
      "target_proj_postgres_data",
      expect.anything()
    )
  })

  it("emits a per-volume summary at the end", async () => {
    await run()
    const messages = logSpy.mock.calls.map((c) => c[0]).join("\n")
    expect(messages).toMatch(/1 volume\(s\) cloned, 0 skipped/)
  })

  it("REGRESSION: all volumes would skip (target has data) → composeStop NEVER called", async () => {
    // The reported regression: even when every volume skips because the target already
    // has data, the old code stopped the source stack first. plan-before-stop must
    // classify all as skip and never stop.
    vi.mocked(volumeModule.getVolumeSize).mockReturnValue(1024) // every target has data
    vi.mocked(volumeModule.getContainersUsingVolumeWithProject).mockReturnValue(
      ownHolders("pg-main")
    )
    await run(false)
    expect(composeModule.composeStop).not.toHaveBeenCalled()
    expect(composeModule.composeStart).not.toHaveBeenCalled()
    expect(volumeModule.copyVolume).not.toHaveBeenCalled()
  })

  it("falls back to composeUp when composeStart throws on restart", async () => {
    vi.mocked(volumeModule.getContainersUsingVolumeWithProject).mockReturnValue(
      ownHolders("pg-main")
    )
    vi.mocked(volumeModule.getContainersUsingVolume).mockReturnValue([])
    vi.mocked(composeModule.composeStart).mockImplementation(() => {
      throw new Error("no such container to start")
    })
    const result = await run(false)
    expect(composeModule.composeStop).toHaveBeenCalledTimes(1)
    expect(composeModule.composeStart).toHaveBeenCalledTimes(1)
    expect(composeModule.composeUp).toHaveBeenCalledTimes(1)
    expect(result.sourceStack).toEqual({ stopped: true, restarted: true })
  })

  it("both composeStart AND composeUp throw → sourceStack.restarted=false + recoverCommand", async () => {
    vi.mocked(volumeModule.getContainersUsingVolumeWithProject).mockReturnValue(
      ownHolders("pg-main")
    )
    vi.mocked(volumeModule.getContainersUsingVolume).mockReturnValue([])
    vi.mocked(composeModule.composeStart).mockImplementation(() => {
      throw new Error("start failed")
    })
    vi.mocked(composeModule.composeUp).mockImplementation(() => {
      throw new Error("up failed")
    })
    const result = await run(false)
    expect(result.sourceStack?.stopped).toBe(true)
    expect(result.sourceStack?.restarted).toBe(false)
    expect(result.sourceStack?.restartError).toContain("up failed")
    expect(result.sourceStack?.recoverCommand).toBe(
      "docker compose -f /repo/docker-compose.yml -p source_proj up -d"
    )
  })

  it("GUARD: source project === target project → all-failed, no stop, no copy", async () => {
    // Fixed `name:` / COMPOSE_PROJECT_NAME makes both project names identical. Cloning
    // would overwrite the source volume with itself — must refuse before stopping.
    vi.mocked(composeModule.resolveComposeProjectName).mockReturnValue("same_proj")
    const result = await run(false)
    expect(composeModule.composeStop).not.toHaveBeenCalled()
    expect(volumeModule.copyVolume).not.toHaveBeenCalled()
    expect(result.cloned).toEqual([])
    expect(result.skipped).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].name).toBe("postgres_data")
    expect(result.failed[0].error).toContain("identical")
  })

  it("GUARD: per-volume fixed name shared across projects (source.name===target.name) → skipped", async () => {
    // resolveVolumeName returns the SAME fixed name regardless of project.
    vi.mocked(volumeModule.resolveVolumeName).mockReturnValue({
      name: "shared_fixed_volume",
      external: false,
    })
    const result = await run(false)
    expect(volumeModule.copyVolume).not.toHaveBeenCalled()
    expect(result.skipped).toEqual([
      {
        name: "postgres_data",
        reason: "volume has a fixed name shared across projects — not cloned",
      },
    ])
  })
})

// ── H5: executeCreateCommand sets exit code 5 when the source stack stays DOWN ───
// The sprint's headline safety contract: if wtb stops the source Compose stack to
// clone a volume and then FAILS to restart it, the command must exit 5
// (DOCKER_ERROR) regardless of --strict, and --json must still flush its payload.
// We drive the REAL setupVolumeCopy through the mocked compose modules so that
// composeStop succeeds but BOTH composeStart and composeUp throw → restarted:false.
describe("executeCreateCommand — source-restart-failure exit code (H5)", () => {
  let command: Command
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    command = createCommand()

    // git / config plumbing for the full create flow.
    vi.mocked(repositoryModule.getGitRootOrThrow).mockReturnValue("/repo")
    vi.mocked(repositoryModule.branchExists).mockReturnValue(false)
    vi.mocked(repositoryModule.remoteBranchExists).mockReturnValue(false)
    vi.mocked(repositoryModule.revisionExists).mockReturnValue(true)
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue(null)
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([])
    vi.mocked(worktreeModule.createWorktree).mockReturnValue(undefined as never)
    vi.mocked(worktreeModule.markWtbManagedFile).mockReturnValue(undefined)
    vi.mocked(clientModule.getUsedPorts).mockReturnValue([])
    vi.mocked(loaderModule.loadConfig).mockReturnValue({
      base_branch: "main",
      docker_compose_file: "./docker-compose.yml",
      copy_files: [],
      link_files: [],
      // empty env to skip the env phase (real fs reads); volume phase is what we exercise.
      env: { file: [], adjust: {} },
      volumes: { exclude: [] },
    } as unknown as WtbConfig)

    // setupVolumeCopy plumbing: one own-project-held volume → clone-after-stop, then
    // restart fails (both composeStart and composeUp throw).
    vi.mocked(composeModule.composeStop).mockReset()
    vi.mocked(composeModule.readComposeFile).mockReturnValue({
      services: { db: { image: "postgres" } },
      volumes: { postgres_data: null },
    } as ComposeConfig)
    vi.mocked(composeModule.resolveComposeProjectName).mockImplementation((_cfg, dir) =>
      dir.endsWith("worktree-feature-x") ? "target_proj" : "source_proj"
    )
    vi.mocked(volumeModule.discoverCloneableVolumes).mockReturnValue(["postgres_data"])
    vi.mocked(volumeModule.resolveVolumeName).mockImplementation((_cfg, key, project) => ({
      name: `${project}_${key}`,
      external: false,
    }))
    vi.mocked(volumeModule.volumeExists).mockReturnValue(true)
    vi.mocked(volumeModule.getVolumeSize).mockReturnValue(0)
    vi.mocked(volumeModule.getContainersUsingVolumeWithProject).mockReturnValue([
      { name: "pg-main", project: "source_proj" },
    ])
    vi.mocked(volumeModule.getContainersUsingVolume).mockReturnValue([])
    vi.mocked(volumeModule.copyVolume).mockResolvedValue(undefined)
    vi.mocked(composeModule.composeStart).mockImplementation(() => {
      throw new Error("start failed")
    })
    vi.mocked(composeModule.composeUp).mockImplementation(() => {
      throw new Error("up failed")
    })
  })

  afterEach(() => {
    process.exitCode = undefined
    vi.restoreAllMocks()
  })

  it("sets process.exitCode=5 (DOCKER_ERROR) in human mode when the source stack fails to restart", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await command.parseAsync(["feature/x"], { from: "user" })

    // process.exit は呼ばず exitCode を設定する (DOCKER_ERROR は --strict 無関係)。
    expect(exit).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(EXIT_CODES.DOCKER_ERROR)
    const messages = logSpy.mock.calls.map((c) => c[0]).join("\n")
    // M6: celebratory banner must NOT appear when the source env is down.
    expect(messages).not.toContain("🎉 Worktree created successfully!")
    expect(messages).toContain("your source environment is DOWN")
    exit.mockRestore()
  })

  it("--json still flushes its payload and sets exitCode=5", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })

    await command.parseAsync(["feature/x", "--json"], { from: "user" })

    expect(exit).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(EXIT_CODES.DOCKER_ERROR)
    // JSON payload still written exactly once.
    const jsonCall = writeSpy.mock.calls.find((c) => String(c[0]).trim().startsWith("{"))
    expect(jsonCall).toBeDefined()
    const payload = JSON.parse(jsonCall?.[0] as string)
    expect(payload.sourceRestartFailed).toBe(true)
    expect(payload.ok).toBe(false)
    writeSpy.mockRestore()
    exit.mockRestore()
  })
})
