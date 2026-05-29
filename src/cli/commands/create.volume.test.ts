/**
 * @fileoverview setupVolumeCopy オーケストレーションのユニットテスト
 *
 * setupVolumeCopy は create.ts の phase 6.5 を担当する 130+ LoC の関数で、
 * 自動 e2e の網にかからない skip 経路 (source 不在 / live source / target populated /
 * copy 失敗) のレグレッションを守るためにテストする。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as composeModule from "../../core/docker/compose.js"
import * as volumeModule from "../../core/docker/volume.js"
import type { ComposeConfig, WtbConfig } from "../../types/index.js"
import { setupVolumeCopy } from "./create.js"

vi.mock("../../core/docker/compose.js")
vi.mock("../../core/docker/volume.js")
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
    vi.mocked(volumeModule.copyVolume).mockResolvedValue(undefined)
  })

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
    expect(messages).toContain("does not exist yet — skipping")
    expect(messages).toContain("0 volume(s) cloned, 1 skipped")
  })

  it("stops the source stack, clones, then restarts when source is running (default)", async () => {
    // Pre-scan sees the running container; after composeStop it is gone, so the
    // per-volume re-check passes and the clone proceeds.
    vi.mocked(volumeModule.getContainersUsingVolume)
      .mockReturnValueOnce(["pg-main"])
      .mockReturnValue([])
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
    vi.mocked(volumeModule.getContainersUsingVolume)
      .mockReturnValueOnce(["pg-main"])
      .mockReturnValue([])
    vi.mocked(volumeModule.copyVolume).mockRejectedValue(new Error("rsync exploded"))
    await run(false)
    expect(composeModule.composeStop).toHaveBeenCalledTimes(1)
    // The finally block must bring the source stack back up despite the failure.
    expect(composeModule.composeStart).toHaveBeenCalledTimes(1)
    const messages = logSpy.mock.calls.map((c) => c[0]).join("\n")
    expect(messages).toContain("Failed to clone postgres_data")
    expect(messages).toContain("Source stack restarted")
  })

  it("skips (and still restarts) a shared volume still in use after stopping the stack", async () => {
    // A foreign Compose project keeps holding the (explicitly-named) volume even
    // after we stop OUR stack — composeStop(-p sourceProject) cannot release it.
    // wtb must NOT live-copy it; it must skip, but still restart our stack.
    vi.mocked(volumeModule.getContainersUsingVolume).mockReturnValue(["other-proj-db"])
    await run(false)
    expect(composeModule.composeStop).toHaveBeenCalledTimes(1)
    expect(volumeModule.copyVolume).not.toHaveBeenCalled()
    expect(composeModule.composeStart).toHaveBeenCalledTimes(1)
    const messages = logSpy.mock.calls.map((c) => c[0]).join("\n")
    expect(messages).toContain("still in use after stopping the source stack")
  })

  it("when composeStop throws, falls back to per-volume skip and does NOT restart", async () => {
    vi.mocked(volumeModule.getContainersUsingVolume).mockReturnValue(["pg-main"])
    vi.mocked(composeModule.composeStop).mockImplementation(() => {
      throw new Error("docker daemon down")
    })
    await run(false)
    expect(volumeModule.copyVolume).not.toHaveBeenCalled()
    // Nothing was stopped, so nothing must be (re)started.
    expect(composeModule.composeStart).not.toHaveBeenCalled()
    const messages = logSpy.mock.calls.map((c) => c[0]).join("\n")
    expect(messages).toContain("Could not stop source stack")
    expect(messages).toContain("is in use by pg-main")
  })

  it("with --no-stop, skips a running source volume (preserves old behavior)", async () => {
    vi.mocked(volumeModule.getContainersUsingVolume).mockReturnValue(["pg-main"])
    await run(false, baseConfig(), false)
    expect(composeModule.composeStop).not.toHaveBeenCalled()
    expect(volumeModule.copyVolume).not.toHaveBeenCalled()
    const messages = logSpy.mock.calls.map((c) => c[0]).join("\n")
    expect(messages).toContain("is in use by pg-main")
    expect(messages).toContain("--no-stop set")
  })

  it("does not stop the stack when no source volume is in use", async () => {
    // Default mock: getContainersUsingVolume returns [] — nothing running.
    await run(false)
    expect(composeModule.composeStop).not.toHaveBeenCalled()
    expect(composeModule.composeStart).not.toHaveBeenCalled()
    expect(volumeModule.copyVolume).toHaveBeenCalledTimes(1)
  })

  it("clones live without stopping when force=true (live-copy path preserved)", async () => {
    vi.mocked(volumeModule.getContainersUsingVolume).mockReturnValue(["pg-main"])
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
    expect(messages).toContain("already has data — skipping")
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

  it("reports failure when copyVolume throws", async () => {
    vi.mocked(volumeModule.copyVolume).mockRejectedValue(new Error("rsync exploded"))
    await run()
    // No container running → stack never stopped → restart must not fire.
    expect(composeModule.composeStart).not.toHaveBeenCalled()
    const messages = logSpy.mock.calls.map((c) => c[0]).join("\n")
    expect(messages).toContain("Failed to clone postgres_data")
    expect(messages).toContain("rsync exploded")
    expect(messages).toContain("0 volume(s) cloned, 1 skipped")
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
})
