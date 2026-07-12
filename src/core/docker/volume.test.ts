import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ComposeConfig } from "../../types/index.js"
import { execDockerSafe } from "../../utils/exec.js"
import { acquireRepositoryLock } from "../git/repository.js"
import {
  acquireTargetVolumeLifecycleLeases,
  acquireVolumeCloneOperationLock,
  buildWtbVolumeLabels,
  copyVolume,
  createVolume,
  discoverCloneableVolumes,
  formatBytes,
  formatEta,
  getContainersUsingVolumeWithProject,
  getVolumeRecoveryDirectory,
  getVolumeSize,
  inspectVolumeOwnership,
  readVolumeRecoveryRecords,
  parseRsyncProgress,
  preflightTargetVolumeForCopy,
  prepareTargetVolumeForCopy,
  resolveVolumeName,
} from "./volume"

vi.mock("../../utils/exec.js", () => ({ execDockerSafe: vi.fn(() => "") }))
vi.mock("node:child_process", () => ({ spawn: vi.fn() }))
vi.mock("../git/repository.js", () => ({
  acquireRepositoryLock: vi.fn(async () => vi.fn()),
}))

interface FakeLeaseContainer {
  id: string
  name: string
  volume: string
  destination: string
  readOnly: boolean
  kind: "source" | "target" | "clone"
  repo?: string
  sourceProject?: string
  running: boolean
}

const fakeLeaseContainers = new Map<string, FakeLeaseContainer>()

const volumeInspection = (
  labels: Record<string, string> = {},
  overrides: { driver?: string; options?: Record<string, string> | null } = {}
) =>
  JSON.stringify({
    Driver: overrides.driver ?? "local",
    Options: overrides.options ?? null,
    Labels: labels,
  })

/** Minimal stateful Docker boundary used by copy tests for running lease containers. */
const handleFakeLeaseDocker = (args: string[]): string | undefined => {
  if (args[0] === "run" && args.includes("--detach") && args.includes("--name")) {
    const name = args[args.indexOf("--name") + 1]
    const mountIndex = args.indexOf("--mount")
    const mountParts =
      mountIndex >= 0
        ? Object.fromEntries(
            args[mountIndex + 1].split(",").map((part) => {
              const equal = part.indexOf("=")
              return equal < 0
                ? [part, "true"]
                : [part.slice(0, equal), part.slice(equal + 1)]
            })
          )
        : {}
    const kind = args.includes("wtb.lock=volume-clone")
      ? "clone"
      : args.includes("wtb.lease=target")
        ? "target"
        : "source"
    const id = createHash("sha256").update(name).digest("hex")
    fakeLeaseContainers.set(id, {
      id,
      name,
      volume: mountParts.src,
      destination: mountParts.dst,
      readOnly: mountParts.readonly === "true",
      kind,
      running: true,
      repo: args.find((arg) => arg.startsWith("wtb.repo="))?.slice("wtb.repo=".length),
      sourceProject: args
        .find((arg) => arg.startsWith("wtb.source-project="))
        ?.slice("wtb.source-project=".length),
    })
    return id
  }
  if (args[0] === "container" && args[1] === "inspect") {
    const lease = fakeLeaseContainers.get(args.at(-1) ?? "")
    if (!lease) throw new Error("No such lease container")
    const labels =
      lease.kind === "clone"
        ? {
            "wtb.temp": "true",
            "wtb.lock": "volume-clone",
            "wtb.repo": lease.repo,
            "wtb.source-project": lease.sourceProject,
          }
        : { "wtb.temp": "true", "wtb.lease": lease.kind }
    return JSON.stringify({
      Id: lease.id,
      Name: `/${lease.name}`,
      Config: { Labels: labels },
      State: { Running: lease.running },
      Mounts:
        lease.kind === "clone"
          ? []
          : [
              {
                Type: "volume",
                Name: lease.volume,
                Destination: lease.destination,
                RW: !lease.readOnly,
              },
            ],
    })
  }
  if (args[0] === "ps") {
    const includeStopped = args.includes("--all")
    const filter = args[args.indexOf("--filter") + 1] ?? ""
    const entries = [...fakeLeaseContainers.values()].filter((lease) => {
      if (!includeStopped && !lease.running) return false
      if (filter.startsWith("volume=")) {
        return lease.kind !== "clone" && lease.volume === filter.slice("volume=".length)
      }
      if (filter.startsWith("name=^")) {
        return lease.name === filter.slice("name=^".length, -1)
      }
      return false
    })
    return entries.map((lease) => `${lease.id}\t${lease.name}`).join("\n")
  }
  if (args[0] === "rm" && args[1] === "-f") {
    fakeLeaseContainers.delete(args.at(-1) ?? "")
    return ""
  }
  return undefined
}

beforeEach(() => {
  fakeLeaseContainers.clear()
})

describe("Volume Utilities", () => {
  describe("formatBytes", () => {
    it("should format 0 bytes", () => {
      expect(formatBytes(0)).toBe("0 B")
    })

    it("should format bytes", () => {
      expect(formatBytes(500)).toBe("500.00 B")
    })

    it("should format kilobytes", () => {
      expect(formatBytes(1024)).toBe("1.00 KB")
      expect(formatBytes(2048)).toBe("2.00 KB")
    })

    it("should format megabytes", () => {
      expect(formatBytes(1024 * 1024)).toBe("1.00 MB")
      expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.50 MB")
    })

    it("should format gigabytes", () => {
      expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00 GB")
    })
  })

  describe("formatEta", () => {
    it("should return placeholder for 0 or negative", () => {
      expect(formatEta(0)).toBe("--:--")
      expect(formatEta(-1)).toBe("--:--")
    })

    it("should format seconds only", () => {
      expect(formatEta(45)).toBe("0:45")
    })

    it("should format minutes and seconds", () => {
      expect(formatEta(90)).toBe("1:30")
      expect(formatEta(125)).toBe("2:05")
    })

    it("should format hours, minutes and seconds", () => {
      expect(formatEta(3661)).toBe("1:01:01")
      expect(formatEta(7325)).toBe("2:02:05")
    })
  })

  describe("resolveVolumeName", () => {
    const baseConfig = (volumes: Record<string, unknown>): ComposeConfig => ({
      services: {},
      volumes: volumes as ComposeConfig["volumes"],
    })

    it("returns null when key is missing", () => {
      const config = baseConfig({ other: null })
      expect(resolveVolumeName(config, "missing", "proj")).toBeNull()
    })

    it("returns null when volumes section is absent", () => {
      const config: ComposeConfig = { services: {} }
      expect(resolveVolumeName(config, "data", "proj")).toBeNull()
    })

    it("uses <project>_<key> for null entry", () => {
      const config = baseConfig({ db_data: null })
      expect(resolveVolumeName(config, "db_data", "myproj")).toEqual({
        name: "myproj_db_data",
        external: false,
      })
    })

    it("uses <project>_<key> for empty object entry", () => {
      const config = baseConfig({ db_data: {} })
      expect(resolveVolumeName(config, "db_data", "myproj")).toEqual({
        name: "myproj_db_data",
        external: false,
      })
    })

    it("uses explicit name override", () => {
      const config = baseConfig({ db_data: { name: "shared_db" } })
      expect(resolveVolumeName(config, "db_data", "myproj")).toEqual({
        name: "shared_db",
        external: false,
      })
    })

    it("flags external: true with no name as external using key", () => {
      const config = baseConfig({ shared: { external: true } })
      expect(resolveVolumeName(config, "shared", "myproj")).toEqual({
        name: "shared",
        external: true,
      })
    })

    it("uses external.name when provided", () => {
      const config = baseConfig({ shared: { external: { name: "global_shared" } } })
      expect(resolveVolumeName(config, "shared", "myproj")).toEqual({
        name: "global_shared",
        external: true,
      })
    })

    it("prefers explicit name over external.name", () => {
      const config = baseConfig({
        shared: { external: { name: "ignored" }, name: "override" },
      })
      expect(resolveVolumeName(config, "shared", "myproj")).toEqual({
        name: "override",
        external: true,
      })
    })

    it("treats non-object entry as default", () => {
      const config = baseConfig({ data: "not-an-object" })
      expect(resolveVolumeName(config, "data", "myproj")).toEqual({
        name: "myproj_data",
        external: false,
      })
    })
  })

  describe("discoverCloneableVolumes", () => {
    it("returns empty when no volumes section", () => {
      expect(discoverCloneableVolumes({ services: {} })).toEqual([])
    })

    it("returns all named volumes by default", () => {
      const config: ComposeConfig = {
        services: {},
        volumes: { db: null, cache: {}, mq: { name: "explicit" } },
      }
      expect(discoverCloneableVolumes(config)).toEqual(["db", "cache", "mq"])
    })

    it("excludes external volumes", () => {
      const config: ComposeConfig = {
        services: {},
        volumes: {
          db: null,
          shared: { external: true },
          ext_named: { external: { name: "x" } },
        },
      }
      expect(discoverCloneableVolumes(config)).toEqual(["db"])
    })

    it("respects exclude list", () => {
      const config: ComposeConfig = {
        services: {},
        volumes: { db: null, cache: {}, mq: {} },
      }
      expect(discoverCloneableVolumes(config, ["cache"])).toEqual(["db", "mq"])
    })

    it("combines external + exclude filters", () => {
      const config: ComposeConfig = {
        services: {},
        volumes: {
          db: null,
          cache: {},
          shared: { external: true },
          mq: {},
        },
      }
      expect(discoverCloneableVolumes(config, ["mq"])).toEqual(["db", "cache"])
    })
  })
})

/**
 * atomic force-overwrite (clearTarget=true) のオーケストレーションを、boundary
 * (execDockerSafe / child_process.spawn) だけ mock して実関数で検証する。
 * 安全保証: staged コピーが完成するまで実 target を絶対に消さない。
 */
describe("copyVolume atomic overwrite", () => {
  const SOURCE = "src_vol"
  const TARGET = "tgt_vol"
  const DU_CMD =
    'if [ -z "$(find /data -mindepth 1 -print -quit)" ]; then echo 0; else tar -C /data -cf - . | wc -c; fi'
  const CLEAR_CMD = "find /target -mindepth 1 -delete"
  const CP_CMD = "cp -a /source/. /target/"
  const OWNER = { repo: "repo123", project: "target_proj", branch: "feature/test" }
  const ownerLabels = (volumeName: string | undefined) =>
    volumeInspection({
      "wtb.managed": "true",
      "wtb.repo": OWNER.repo,
      "wtb.project": OWNER.project,
      "wtb.branch": OWNER.branch,
      ...(volumeName?.includes("__wtbtmp_") || volumeName?.includes("__wtbincomplete_")
        ? { "wtb.temp": "true" }
        : {}),
    })
  let commonGitDir: string
  let recoveryDirectory: string
  let recoveryVisibleAtTargetClear: boolean
  const overwriteOptions = () => ({
    clearTarget: true as const,
    ownership: OWNER,
    recoveryDirectory,
  })

  // mount 引数 (`<vol>:/data` 等) から volume 名を取り出す
  const mountVol = (args: string[], suffix: string): string => {
    const m = args.find((a) => a.endsWith(suffix)) ?? ""
    return m.slice(0, -suffix.length)
  }

  const fakeRsyncProc = (closeCode: number) => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
    }
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    setImmediate(() => proc.emit("close", closeCode))
    return proc
  }

  const calls = () => vi.mocked(execDockerSafe).mock.calls.map((c) => c[0] as string[])
  const tempName = () => {
    const create = calls().find(
      (a) => a[0] === "volume" && a[1] === "create" && a.at(-1)?.startsWith(`${TARGET}__wtbtmp_`)
    )
    return create?.at(-1)
  }
  const clearedTarget = () =>
    calls().some((a) => a.includes(CLEAR_CMD) && a.includes(`${TARGET}:/target`))
  const removedTemp = () =>
    calls().some(
      (a) => a[0] === "volume" && a[1] === "rm" && (a.at(-1) ?? "").startsWith(`${TARGET}__wtbtmp_`)
    )

  let logSpy: ReturnType<typeof vi.spyOn>
  const logged = () => logSpy.mock.calls.map((c) => c[0]).join("\n")

  beforeEach(() => {
    vi.clearAllMocks()
    commonGitDir = mkdtempSync(path.join(tmpdir(), "wtb-volume-common-git-"))
    recoveryDirectory = getVolumeRecoveryDirectory(commonGitDir)
    recoveryVisibleAtTargetClear = false
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    // staging-failure tests deliberately fail rsync → copyVolume logs a
    // "rsync copy failed, falling back to cp" warning. Silence it for clean output.
    vi.spyOn(console, "warn").mockImplementation(() => {})
    // default: rsync succeeds; source & temp both non-empty
    vi.mocked(spawn).mockImplementation(() => fakeRsyncProc(0) as never)
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args.includes(CLEAR_CMD) && args.includes(`${TARGET}:/target`)) {
        recoveryVisibleAtTargetClear = readdirSync(recoveryDirectory).some((name) =>
          name.endsWith(".json")
        )
      }
      if (args[0] === "volume" && args[1] === "ls") {
        return args.some((arg) => arg.includes(TARGET)) ? TARGET : ""
      }
      if (args[0] === "volume" && args[1] === "inspect" && args.includes("{{json .}}")) {
        return ownerLabels(args.at(-1))
      }
      if (args.includes(DU_CMD)) {
        const vol = mountVol(args, ":/data:ro")
        return vol === SOURCE || vol === TARGET || vol.includes("__wtbtmp_") ? "100" : "0"
      }
      return handleFakeLeaseDocker(args) ?? ""
    })
  })

  afterEach(() => {
    rmSync(commonGitDir, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  it("stages into a temp volume, then clears+refills the target, then removes the temp", async () => {
    await copyVolume(SOURCE, TARGET, overwriteOptions())

    const tmp = tempName()
    expect(tmp).toBeDefined()
    // staging used rsync (spawn) — the slow real transfer into the temp volume
    expect(spawn).toHaveBeenCalled()

    const seq = calls()
    const clearIdx = seq.findIndex((a) => a.includes(CLEAR_CMD) && a.includes(`${TARGET}:/target`))
    const refillIdx = seq.findIndex(
      (a) =>
        a.includes(CP_CMD) && a.includes(`${tmp}:/source:ro`) && a.includes(`${TARGET}:/target`)
    )
    const rmIdx = seq.findIndex(
      (a) => a[0] === "volume" && a[1] === "rm" && a.includes(tmp as string)
    )
    const targetLeaseCreate = seq.find(
      (a) =>
        a[0] === "run" &&
        a.includes("wtb.lease=target") &&
        a.includes(`type=volume,src=${TARGET},dst=/wtb-target`)
    )
    const targetLeaseReleaseIdx = seq.findIndex(
      (a) =>
        a[0] === "rm" &&
        a[1] === "-f" &&
        a.at(-1) ===
          createHash("sha256").update(targetLeaseCreate?.[3] ?? "").digest("hex")
    )

    // target is cleared and refilled from the verified temp, then temp removed last
    expect(clearIdx).toBeGreaterThanOrEqual(0)
    expect(refillIdx).toBeGreaterThan(clearIdx)
    expect(rmIdx).toBeGreaterThan(refillIdx)
    // The real target remains pinned beyond clear/refill, committed-size verification,
    // recovery-record cleanup, and temp cleanup. Outer copyVolume releases it last.
    expect(targetLeaseCreate).toBeDefined()
    expect(targetLeaseReleaseIdx).toBeGreaterThan(rmIdx)
    expect(recoveryVisibleAtTargetClear).toBe(true)
    expect(readdirSync(recoveryDirectory)).toEqual([])
    const tempCreate = seq.find(
      (args) => args[0] === "volume" && args[1] === "create" && args.at(-1) === tmp
    )
    expect(tempCreate).toEqual(
      expect.arrayContaining([
        "wtb.repo=repo123",
        "wtb.project=target_proj",
        "wtb.branch=feature/test",
        "wtb.temp=true",
      ])
    )
  })

  it("holds the repository lock only across revalidation, commit, and temp cleanup", async () => {
    const release = vi.fn().mockResolvedValue(undefined)
    vi.mocked(acquireRepositoryLock).mockResolvedValueOnce(release)

    await copyVolume(SOURCE, TARGET, overwriteOptions())

    const docker = vi.mocked(execDockerSafe)
    const lockOrder = vi.mocked(acquireRepositoryLock).mock.invocationCallOrder[0]
    const clearIndex = docker.mock.calls.findIndex(
      ([args]) => args.includes(CLEAR_CMD) && args.includes(`${TARGET}:/target`)
    )
    const temp = tempName() as string
    const tempRemoveIndex = docker.mock.calls.findIndex(
      ([args]) => args[0] === "volume" && args[1] === "rm" && args.at(-1) === temp
    )
    const postLockSizeChecks = docker.mock.calls
      .map(([args], index) => ({ args, order: docker.mock.invocationCallOrder[index] }))
      .filter(
        ({ args, order }) =>
          order > lockOrder &&
          order < docker.mock.invocationCallOrder[clearIndex] &&
          args.includes(DU_CMD) &&
          (args.includes(`${SOURCE}:/data:ro`) || args.includes(`${temp}:/data:ro`))
      )

    expect(acquireRepositoryLock).toHaveBeenCalledWith(commonGitDir)
    // The slow rsync stage completes before contending on create/prune's repository lock.
    expect(vi.mocked(spawn).mock.invocationCallOrder[0]).toBeLessThan(lockOrder)
    // Both source and staged byte counts are recomputed under the lock before target deletion.
    expect(postLockSizeChecks.length).toBeGreaterThanOrEqual(2)
    expect(
      postLockSizeChecks.map(({ args }) => mountVol(args, ":/data:ro"))
    ).toEqual(expect.arrayContaining([SOURCE, temp]))
    expect(lockOrder).toBeLessThan(docker.mock.invocationCallOrder[clearIndex])
    expect(release.mock.invocationCallOrder[0]).toBeGreaterThan(
      docker.mock.invocationCallOrder[tempRemoveIndex]
    )
  })

  it("never clears the target when staging fails (existing target data preserved)", async () => {
    // rsync fails → cp fallback into the temp → make that cp blow up
    vi.mocked(spawn).mockImplementation(() => fakeRsyncProc(1) as never)
    let tempCleared = false
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args[0] === "volume" && args[1] === "ls") {
        return args.some((arg) => arg.includes(TARGET)) ? TARGET : ""
      }
      if (args[0] === "volume" && args[1] === "inspect" && args.includes("{{json .}}")) {
        return ownerLabels(args.at(-1))
      }
      if (
        args.includes(CLEAR_CMD) &&
        args.some((x) => x.includes("__wtbtmp_") && x.endsWith(":/target"))
      ) {
        tempCleared = true
      }
      if (args.includes(DU_CMD)) {
        const volume = mountVol(args, ":/data:ro")
        return tempCleared && volume.includes("__wtbtmp_") ? "0" : "100"
      }
      if (
        args.includes(CP_CMD) &&
        args.some((x) => x.includes("__wtbtmp_") && x.endsWith(":/target"))
      ) {
        throw new Error("cp into temp failed")
      }
      return handleFakeLeaseDocker(args) ?? ""
    })

    await expect(copyVolume(SOURCE, TARGET, overwriteOptions())).rejects.toThrow()
    // the real target must be untouched, and the temp cleaned up
    expect(clearedTarget()).toBe(false)
    expect(removedTemp()).toBe(true)
    expect(acquireRepositoryLock).not.toHaveBeenCalled()
  })

  it("aborts without clearing the target when the staged copy is empty", async () => {
    // rsync 'succeeds' but the temp ends up empty while source has data
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args[0] === "volume" && args[1] === "ls") {
        return args.some((arg) => arg.includes(TARGET)) ? TARGET : ""
      }
      if (args[0] === "volume" && args[1] === "inspect" && args.includes("{{json .}}")) {
        return ownerLabels(args.at(-1))
      }
      if (args.includes(DU_CMD)) {
        const vol = mountVol(args, ":/data:ro")
        return vol === SOURCE ? "100" : "0"
      }
      return handleFakeLeaseDocker(args) ?? ""
    })

    await expect(copyVolume(SOURCE, TARGET, overwriteOptions())).rejects.toThrow(/size mismatch/)
    expect(clearedTarget()).toBe(false)
    expect(removedTemp()).toBe(true)
  })

  it("rechecks target usage after staging and refuses a newly-live target", async () => {
    let targetUsageChecks = 0
    const implementation = vi.mocked(execDockerSafe).getMockImplementation()
    vi.mocked(execDockerSafe).mockImplementation((args: string[], options) => {
      if (args[0] === "ps" && args.some((arg) => arg === `volume=${TARGET}`)) {
        targetUsageChecks++
        return targetUsageChecks < 3 ? "" : "target-db"
      }
      return implementation?.(args, options) ?? ""
    })

    await expect(copyVolume(SOURCE, TARGET, overwriteOptions())).rejects.toThrow(
      /in use by target-db/
    )
    expect(targetUsageChecks).toBe(3)
    expect(clearedTarget()).toBe(false)
    expect(removedTemp()).toBe(true)
    expect(readVolumeRecoveryRecords(recoveryDirectory)).toEqual([])
  })

  it("uses the direct (non-atomic) path when clearTarget is not set", async () => {
    const implementation = vi.mocked(execDockerSafe).getMockImplementation()
    vi.mocked(execDockerSafe).mockImplementation((args: string[], options) => {
      if (args[0] === "volume" && args[1] === "ls") return ""
      return implementation?.(args, options) ?? ""
    })
    await copyVolume(SOURCE, TARGET, { ownership: OWNER })
    // no temp volume, no target clear — just a direct rsync into the target
    expect(tempName()).toBeUndefined()
    expect(clearedTarget()).toBe(false)
    expect(spawn).toHaveBeenCalled()
  })

  it("aborts without clearing the target when the volume-size probe fails", async () => {
    // du errors → getVolumeSize returns null. The verify gate must treat 'cannot
    // determine' as abort, NOT as 'empty', so the destructive commit never runs.
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args[0] === "volume" && args[1] === "ls") {
        return args.some((arg) => arg.includes(TARGET)) ? TARGET : ""
      }
      if (args[0] === "volume" && args[1] === "inspect" && args.includes("{{json .}}")) {
        return ownerLabels(args.at(-1))
      }
      if (args.includes(DU_CMD)) {
        const vol = mountVol(args, ":/data:ro")
        if (vol === TARGET) return "100"
        throw new Error("docker daemon hiccup")
      }
      return handleFakeLeaseDocker(args) ?? ""
    })
    await expect(copyVolume(SOURCE, TARGET, overwriteOptions())).rejects.toThrow(/probe failed/)
    expect(clearedTarget()).toBe(false)
    expect(removedTemp()).toBe(true)
  })

  it("preserves the staged temp volume when the commit fails mid-overwrite", async () => {
    // staging (rsync) + verify succeed, but the commit cp into the REAL target fails
    // (e.g. disk full). The target is now cleared/partial, so the verified copy in the
    // temp volume is the ONLY intact data and must NOT be deleted.
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args[0] === "volume" && args[1] === "ls") {
        return args.some((arg) => arg.includes(TARGET)) ? TARGET : ""
      }
      if (args[0] === "volume" && args[1] === "inspect" && args.includes("{{json .}}")) {
        return ownerLabels(args.at(-1))
      }
      if (args.includes(DU_CMD)) {
        const vol = mountVol(args, ":/data:ro")
        return vol === SOURCE || vol.includes("__wtbtmp_") ? "100" : "0"
      }
      if (args.includes(CP_CMD) && args.includes(`${TARGET}:/target`)) {
        throw new Error("disk full during commit")
      }
      return handleFakeLeaseDocker(args) ?? ""
    })

    await expect(copyVolume(SOURCE, TARGET, overwriteOptions())).rejects.toThrow()
    // commit started (target was cleared) but the temp volume must be preserved
    expect(clearedTarget()).toBe(true)
    expect(removedTemp()).toBe(false)
    const records = readVolumeRecoveryRecords(recoveryDirectory)
    expect(records).toHaveLength(1)
    expect(records[0].record).toMatchObject({
      sourceVolume: SOURCE,
      targetVolume: TARGET,
      tempVolume: expect.stringContaining(`${TARGET}__wtbtmp_`),
      sourceBytes: 100,
      stagedBytes: 100,
      ownership: OWNER,
    })
    // and the user is told how to recover from the temp volume
    expect(logged()).toContain("preserved in temp volume")
  })

  it("refuses a missing or replaced source before touching the target", async () => {
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args[0] === "volume" && args[1] === "inspect" && args.at(-1) === SOURCE) {
        throw new Error("No such volume")
      }
      return ""
    })

    await expect(copyVolume(SOURCE, TARGET, overwriteOptions())).rejects.toThrow(
      /No such volume/
    )
    expect(clearedTarget()).toBe(false)
  })

  it("keeps recovery data when a successful commit has the wrong byte size", async () => {
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args[0] === "volume" && args[1] === "ls") {
        return args.some((arg) => arg.includes(TARGET)) ? TARGET : ""
      }
      if (args[0] === "volume" && args[1] === "inspect" && args.includes("{{json .}}")) {
        return ownerLabels(args.at(-1))
      }
      if (args.includes(DU_CMD)) {
        const vol = mountVol(args, ":/data:ro")
        return vol === TARGET ? "50" : "100"
      }
      return handleFakeLeaseDocker(args) ?? ""
    })

    await expect(copyVolume(SOURCE, TARGET, overwriteOptions())).rejects.toThrow(
      /Committed volume size mismatch/
    )
    expect(clearedTarget()).toBe(true)
    expect(removedTemp()).toBe(false)
    expect(readVolumeRecoveryRecords(recoveryDirectory)).toHaveLength(1)
  })

  it("pins a failed fresh target and persists an incomplete marker when cleanup also fails", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeRsyncProc(1) as never)
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args[0] === "volume" && args[1] === "ls") return ""
      if (args[0] === "volume" && args[1] === "inspect" && args.includes("{{json .}}")) {
        return ownerLabels(args.at(-1))
      }
      if (args.includes(DU_CMD)) {
        const volume = mountVol(args, ":/data:ro")
        return volume === SOURCE ? "100" : "50"
      }
      if (args.includes(CLEAR_CMD) && args.includes(`${TARGET}:/target`)) {
        throw new Error("cannot clear partial target")
      }
      return handleFakeLeaseDocker(args) ?? ""
    })

    await expect(
      copyVolume(SOURCE, TARGET, { ownership: OWNER, recoveryDirectory })
    ).rejects.toThrow(/Recovery marker.*running lease.*preserved/)

    const records = readVolumeRecoveryRecords(recoveryDirectory)
    expect(records).toHaveLength(1)
    expect(records[0].record).toMatchObject({
      kind: "incomplete-fresh-copy",
      sourceVolume: SOURCE,
      targetVolume: TARGET,
      tempVolume: expect.stringContaining(`${TARGET}__wtbincomplete_`),
      stagedBytes: 50,
      ownership: OWNER,
    })
    const targetLease = [...fakeLeaseContainers.values()].find(
      (lease) => lease.kind === "target" && lease.volume === TARGET
    )
    expect(targetLease).toMatchObject({ running: true })
    expect(
      calls().some(
        (args) => args[0] === "rm" && args[1] === "-f" && args.at(-1) === targetLease?.id
      )
    ).toBe(false)
  })

  it("requires ownership metadata even on the non-overwrite path", async () => {
    await expect(copyVolume(SOURCE, TARGET, {} as never)).rejects.toThrow(/ownership metadata/)
  })
})

describe("getVolumeSize", () => {
  it("uses an entry-aware content byte count so an empty volume is exactly zero", () => {
    vi.clearAllMocks()
    vi.mocked(execDockerSafe).mockReturnValue("0")
    expect(getVolumeSize("empty_vol")).toBe(0)
    expect(vi.mocked(execDockerSafe).mock.calls[0][0]).toEqual(
      expect.arrayContaining([expect.stringContaining("find /data -mindepth 1")])
    )
  })
})

describe("createVolume", () => {
  it("creates the volume with the wtb.managed=true label (self-identifying)", () => {
    vi.clearAllMocks()
    vi.mocked(execDockerSafe).mockReturnValue("")
    createVolume("some_vol")
    const args = vi.mocked(execDockerSafe).mock.calls[0][0] as string[]
    expect(args[0]).toBe("volume")
    expect(args[1]).toBe("create")
    expect(args).toContain("--label")
    expect(args).toContain("wtb.managed=true")
    // the volume name remains the final argument
    expect(args.at(-1)).toBe("some_vol")
  })

  it("adds repo/project/branch/temp ownership labels", () => {
    vi.clearAllMocks()
    vi.mocked(execDockerSafe).mockReturnValue("")
    const ownership = { repo: "repo123", project: "proj", branch: "feature/x" }
    createVolume("owned_vol", "local", buildWtbVolumeLabels(ownership, { temp: true }))
    const args = vi.mocked(execDockerSafe).mock.calls[0][0] as string[]
    expect(args).toEqual(
      expect.arrayContaining([
        "wtb.managed=true",
        "wtb.repo=repo123",
        "wtb.project=proj",
        "wtb.branch=feature/x",
        "wtb.temp=true",
      ])
    )
  })
})

describe("volume ownership safety", () => {
  const TARGET = "target_vol"
  const OWNER = { repo: "repo123", project: "proj", branch: "feature/x" }
  const DU_CMD =
    'if [ -z "$(find /data -mindepth 1 -print -quit)" ]; then echo 0; else tar -C /data -cf - . | wc -c; fi'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("parses all ownership labels from docker inspect", () => {
    vi.mocked(execDockerSafe).mockReturnValue(
      volumeInspection({
        "wtb.managed": "true",
        "wtb.repo": OWNER.repo,
        "wtb.project": OWNER.project,
        "wtb.branch": OWNER.branch,
        "wtb.temp": "true",
      })
    )
    expect(inspectVolumeOwnership(TARGET)).toMatchObject({
      managed: true,
      ...OWNER,
      temp: true,
    })
  })

  it("refuses a data-filled unmanaged target even when overwrite is authorized", () => {
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args[0] === "volume" && args[1] === "ls") return TARGET
      if (args.includes(DU_CMD)) return "42"
      if (args[0] === "volume" && args[1] === "inspect") return volumeInspection()
      return ""
    })
    expect(() =>
      prepareTargetVolumeForCopy(TARGET, OWNER, { allowOverwrite: true })
    ).toThrow(/not wtb-managed/)
    expect(
      vi.mocked(execDockerSafe).mock.calls.some((call) => {
        const args = call[0] as string[]
        return args[0] === "volume" && args[1] === "rm"
      })
    ).toBe(false)
  })

  it("rejects a non-local existing target before mounting it for a size probe", () => {
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args[0] === "volume" && args[1] === "ls") return TARGET
      if (args[0] === "volume" && args[1] === "inspect") {
        return volumeInspection({}, { driver: "nfs" })
      }
      return ""
    })

    expect(() => preflightTargetVolumeForCopy(TARGET, OWNER)).toThrow(/unsupported driver 'nfs'/)
    expect(
      vi.mocked(execDockerSafe).mock.calls.some(([args]) => args.includes(DU_CMD))
    ).toBe(false)
    expect(
      vi.mocked(execDockerSafe).mock.calls.some(
        ([args]) => args[0] === "volume" && args[1] === "rm"
      )
    ).toBe(false)
  })

  it("rejects local bind-backed driver options before mounting or removing the target", () => {
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args[0] === "volume" && args[1] === "ls") return TARGET
      if (args[0] === "volume" && args[1] === "inspect") {
        return volumeInspection({}, { options: { type: "none", o: "bind", device: "/srv/data" } })
      }
      return ""
    })

    expect(() => preflightTargetVolumeForCopy(TARGET, OWNER)).toThrow(/driver options/)
    expect(
      vi.mocked(execDockerSafe).mock.calls.some(([args]) => args.includes(DU_CMD))
    ).toBe(false)
    expect(
      vi.mocked(execDockerSafe).mock.calls.some(
        ([args]) => args[0] === "volume" && args[1] === "rm"
      )
    ).toBe(false)
  })

  it("returns the strictly measured size for an exactly owned target during planning", () => {
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args[0] === "volume" && args[1] === "ls") return TARGET
      if (args[0] === "ps") return ""
      if (args.includes(DU_CMD)) return "42"
      if (args[0] === "volume" && args[1] === "inspect") {
        return volumeInspection({
          "wtb.managed": "true",
          "wtb.repo": OWNER.repo,
          "wtb.project": OWNER.project,
          "wtb.branch": OWNER.branch,
        })
      }
      return ""
    })

    expect(preflightTargetVolumeForCopy(TARGET, OWNER)).toEqual({
      state: "owned",
      size: 42,
    })
  })

  it("refuses a managed target owned by another branch", () => {
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args[0] === "volume" && args[1] === "ls") return TARGET
      if (args.includes(DU_CMD)) return "42"
      if (args[0] === "volume" && args[1] === "inspect") {
        return volumeInspection({
          "wtb.managed": "true",
          "wtb.repo": OWNER.repo,
          "wtb.project": OWNER.project,
          "wtb.branch": "feature/other",
        })
      }
      return ""
    })
    expect(() =>
      prepareTargetVolumeForCopy(TARGET, OWNER, { allowOverwrite: true })
    ).toThrow(/another wtb target/)
  })

  it("refuses to overwrite an owned target while a container is using it", () => {
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args[0] === "volume" && args[1] === "ls") return TARGET
      if (args[0] === "ps") return "target-db"
      return ""
    })

    expect(() =>
      prepareTargetVolumeForCopy(TARGET, OWNER, { allowOverwrite: true })
    ).toThrow(/in use by target-db/)
  })

  it("recreates an empty unmanaged target only after confirming it is unused", () => {
    let listCalls = 0
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args[0] === "volume" && args[1] === "ls") {
        listCalls++
        return listCalls === 1 ? TARGET : ""
      }
      if (args.includes(DU_CMD)) return "0"
      if (args[0] === "volume" && args[1] === "inspect") return volumeInspection()
      if (args[0] === "ps") return ""
      return ""
    })
    expect(prepareTargetVolumeForCopy(TARGET, OWNER, { allowOverwrite: false })).toBe(
      "recreated-empty"
    )
    expect(
      vi.mocked(execDockerSafe).mock.calls.some((call) => {
        const args = call[0] as string[]
        return args[0] === "volume" && args[1] === "rm" && args.at(-1) === TARGET
      })
    ).toBe(true)
  })

  it("does not recreate an empty unmanaged target while a container uses it", () => {
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args[0] === "volume" && args[1] === "ls") return TARGET
      if (args.includes(DU_CMD)) return "0"
      if (args[0] === "volume" && args[1] === "inspect") return volumeInspection()
      if (args[0] === "ps") return "holder"
      return ""
    })
    expect(() =>
      prepareTargetVolumeForCopy(TARGET, OWNER, { allowOverwrite: false })
    ).toThrow(/in use by holder/)
  })

  it("rejects a valid stopped deterministic target lease without auto-removing it", () => {
    const name = `wtb-target-lease-${createHash("sha1")
      .update(TARGET)
      .digest("hex")
      .slice(0, 12)}`
    const id = createHash("sha256").update(name).digest("hex")
    fakeLeaseContainers.set(id, {
      id,
      name,
      volume: TARGET,
      destination: "/wtb-target",
      readOnly: false,
      kind: "target",
      running: false,
    })
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      return handleFakeLeaseDocker(args) ?? ""
    })

    expect(() => preflightTargetVolumeForCopy(TARGET, OWNER)).toThrow(
      /Unresolved stopped target volume lease/
    )
    expect(fakeLeaseContainers.has(id)).toBe(true)
    expect(
      vi.mocked(execDockerSafe).mock.calls.some(
        ([args]) => args[0] === "rm" && args.at(-1) === id
      )
    ).toBe(false)
  })
})

describe("parseRsyncProgress", () => {
  it("parses a full progress2 line with ETA", () => {
    const r = parseRsyncProgress("      1,234,567  45%   12.34MB/s    0:00:12")
    expect(r).toEqual({
      bytesTransferred: 1234567,
      percentage: 45,
      speed: 12.34 * 1024 * 1024,
      eta: 12,
    })
  })

  it("computes ETA across hours/minutes/seconds", () => {
    const r = parseRsyncProgress("100 50% 1.0kB/s 1:02:03")
    expect(r?.eta).toBe(3600 + 2 * 60 + 3)
    expect(r?.speed).toBe(1024)
  })

  it("tolerates a missing ETA (eta=0)", () => {
    const r = parseRsyncProgress("  9,999  88%   5.00GB/s")
    expect(r).not.toBeNull()
    expect(r?.percentage).toBe(88)
    expect(r?.bytesTransferred).toBe(9999)
    expect(r?.speed).toBe(5 * 1024 * 1024 * 1024)
    expect(r?.eta).toBe(0)
  })

  it("reports speed=0 for an unknown unit instead of misreading it as bytes", () => {
    // a hypothetical/unknown unit must NOT be silently treated as B/s (×1)
    const r = parseRsyncProgress("500 10% 3.00pb/s 0:00:01")
    expect(r).not.toBeNull()
    expect(r?.speed).toBe(0)
  })

  it("returns null for a non-progress line", () => {
    expect(parseRsyncProgress("sending incremental file list")).toBeNull()
    expect(parseRsyncProgress("")).toBeNull()
  })
})

/**
 * rsync の失敗診断 (#10 stderr capture) と、rsync→cp フォールバックが fresh target
 * を必ず clean にしてからコピーする (#4) ことを boundary mock で検証する。
 */
describe("copyVolume rsync robustness", () => {
  const SOURCE = "src_vol"
  const TARGET = "tgt_vol"
  const DU_CMD =
    'if [ -z "$(find /data -mindepth 1 -print -quit)" ]; then echo 0; else tar -C /data -cf - . | wc -c; fi'
  const CLEAR_CMD = "find /target -mindepth 1 -delete"
  const CP_CMD = "cp -a /source/. /target/"
  const OWNER = { repo: "repo123", project: "target_proj", branch: "feature/test" }

  const calls = () => vi.mocked(execDockerSafe).mock.calls.map((c) => c[0] as string[])

  // stderr を吐いてから指定コードで close する fake rsync プロセス
  const fakeProcWithStderr = (closeCode: number, stderrText?: string) => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
    }
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    setImmediate(() => {
      if (stderrText) proc.stderr.emit("data", Buffer.from(stderrText))
      proc.emit("close", closeCode)
    })
    return proc
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args.includes(DU_CMD)) return "100"
      if (args[0] === "volume" && args[1] === "inspect" && args.includes("{{json .}}")) {
        return volumeInspection({
          "wtb.managed": "true",
          "wtb.repo": OWNER.repo,
          "wtb.project": OWNER.project,
          "wtb.branch": OWNER.branch,
        })
      }
      return handleFakeLeaseDocker(args) ?? ""
    })
  })

  it("folds rsync stderr into the thrown error so failures are diagnosable", async () => {
    vi.mocked(spawn).mockImplementation(
      () =>
        fakeProcWithStderr(23, "rsync: failed to set permissions: Operation not permitted") as never
    )
    const implementation = vi.mocked(execDockerSafe).getMockImplementation()
    vi.mocked(execDockerSafe).mockImplementation((args: string[], options) => {
      if (args.includes(CP_CMD)) throw new Error("cp also failed")
      return implementation?.(args, options) ?? ""
    })
    await expect(copyVolume(SOURCE, TARGET, { ownership: OWNER })).rejects.toThrow(
      /exit code 23.*Operation not permitted/s
    )
  })

  it("cp fallback starts from a clean target after a partial rsync (non-atomic path)", async () => {
    // rsync fails partway → copyVolume falls back to cp. The fallback must clear the
    // target first to discard rsync's partial tree, reproducing --delete semantics.
    vi.mocked(spawn).mockImplementation(() => fakeProcWithStderr(1, "partial write") as never)

    await copyVolume(SOURCE, TARGET, { ownership: OWNER })

    const seq = calls()
    const clearIdx = seq.findIndex((a) => a.includes(CLEAR_CMD) && a.includes(`${TARGET}:/target`))
    const cpIdx = seq.findIndex(
      (a) =>
        a.includes(CP_CMD) && a.includes(`${SOURCE}:/source:ro`) && a.includes(`${TARGET}:/target`)
    )
    expect(clearIdx).toBeGreaterThanOrEqual(0)
    expect(cpIdx).toBeGreaterThan(clearIdx)
  })

  it("clears and releases a fresh target when both transfers fail but cleanup succeeds", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeProcWithStderr(1, "partial write") as never)
    const implementation = vi.mocked(execDockerSafe).getMockImplementation()
    let cleared = false
    vi.mocked(execDockerSafe).mockImplementation((args: string[], options) => {
      if (args.includes(CLEAR_CMD) && args.includes(`${TARGET}:/target`)) cleared = true
      if (args.includes(CP_CMD) && args.includes(`${TARGET}:/target`)) {
        throw new Error("cp also failed")
      }
      if (args.includes(DU_CMD) && args.includes(`${TARGET}:/data:ro`) && cleared) return "0"
      return implementation?.(args, options) ?? ""
    })

    await expect(copyVolume(SOURCE, TARGET, { ownership: OWNER })).rejects.toThrow(
      /cp fallback failed.*cp also failed/
    )
    expect(
      calls().filter(
        (args) => args.includes(CLEAR_CMD) && args.includes(`${TARGET}:/target`)
      )
    ).toHaveLength(2)
    expect(
      [...fakeLeaseContainers.values()].some(
        (lease) => lease.kind === "target" && lease.volume === TARGET
      )
    ).toBe(false)
    expect(acquireRepositoryLock).not.toHaveBeenCalled()
  })

  it("refuses a target replaced while its stopped-container lease is being acquired", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeProcWithStderr(0) as never)
    let targetSnapshots = 0
    const implementation = vi.mocked(execDockerSafe).getMockImplementation()
    vi.mocked(execDockerSafe).mockImplementation((args: string[], options) => {
      if (
        args[0] === "volume" &&
        args[1] === "inspect" &&
        !args.includes("{{json .}}") &&
        args.at(-1) === TARGET
      ) {
        targetSnapshots++
        return targetSnapshots === 1 ? "target-before" : "target-replaced"
      }
      return implementation?.(args, options) ?? ""
    })

    await expect(copyVolume(SOURCE, TARGET, { ownership: OWNER })).rejects.toThrow(
      /changed while acquiring a copy lease/
    )

    expect(spawn).not.toHaveBeenCalled()
    const targetLeaseCreate = calls().find(
      (args) => args[0] === "run" && args.includes("wtb.lease=target")
    )
    expect(targetLeaseCreate).toBeDefined()
    expect(
      calls().some(
        (args) =>
          args[0] === "rm" &&
          args[1] === "-f" &&
          args.at(-1) ===
            createHash("sha256").update(targetLeaseCreate?.[3] ?? "").digest("hex")
      )
    ).toBe(true)
  })

  it("rechecks the leased target immediately before rsync and rejects a forced replacement", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeProcWithStderr(0) as never)
    let targetSnapshots = 0
    const implementation = vi.mocked(execDockerSafe).getMockImplementation()
    vi.mocked(execDockerSafe).mockImplementation((args: string[], options) => {
      if (
        args[0] === "volume" &&
        args[1] === "inspect" &&
        !args.includes("{{json .}}") &&
        args.at(-1) === TARGET
      ) {
        targetSnapshots++
        return targetSnapshots < 4 ? "leased-target" : "replacement-after-lease"
      }
      return implementation?.(args, options) ?? ""
    })

    await expect(copyVolume(SOURCE, TARGET, { ownership: OWNER })).rejects.toThrow(
      /changed after its copy lease was acquired/
    )

    // rsync rejects the changed snapshot, then the cp fallback and fail-closed cleanup each
    // independently revalidate the pinned target.
    expect(targetSnapshots).toBe(6)
    expect(spawn).not.toHaveBeenCalled()
  })

  it("holds the target lease from before rsync until after the transfer completes", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeProcWithStderr(0) as never)

    await copyVolume(SOURCE, TARGET, { ownership: OWNER })

    const execCalls = vi.mocked(execDockerSafe).mock.calls
    const targetLeaseCreateIndex = execCalls.findIndex(
      (call) => call[0][0] === "run" && (call[0] as string[]).includes("wtb.lease=target")
    )
    expect(targetLeaseCreateIndex).toBeGreaterThanOrEqual(0)
    const targetLeaseName = (execCalls[targetLeaseCreateIndex][0] as string[])[3]
    expect(targetLeaseName).toBe(
      `wtb-target-lease-${createHash("sha1").update(TARGET).digest("hex").slice(0, 12)}`
    )
    const targetLeaseReleaseIndex = execCalls.findIndex(
      (call) =>
        call[0][0] === "rm" &&
        call[0][1] === "-f" &&
        (call[0] as string[]).at(-1) ===
          createHash("sha256").update(targetLeaseName).digest("hex")
    )
    expect(targetLeaseReleaseIndex).toBeGreaterThan(targetLeaseCreateIndex)

    const leaseCreateOrder = vi.mocked(execDockerSafe).mock.invocationCallOrder[
      targetLeaseCreateIndex
    ]
    const transferOrder = vi.mocked(spawn).mock.invocationCallOrder[0]
    const leaseReleaseOrder = vi.mocked(execDockerSafe).mock.invocationCallOrder[
      targetLeaseReleaseIndex
    ]
    expect(leaseCreateOrder).toBeLessThan(transferOrder)
    expect(transferOrder).toBeLessThan(leaseReleaseOrder)
  })

  it("treats a deterministic target-lease name collision as a lock and never removes it", async () => {
    const deterministicLease = `wtb-target-lease-${createHash("sha1")
      .update(TARGET)
      .digest("hex")
      .slice(0, 12)}`
    const implementation = vi.mocked(execDockerSafe).getMockImplementation()
    vi.mocked(execDockerSafe).mockImplementation((args: string[], options) => {
      if (
        args[0] === "run" &&
        args[1] === "--detach" &&
        args[2] === "--name" &&
        args[3] === deterministicLease
      ) {
        throw new Error(`Conflict. The container name "/${deterministicLease}" is already in use`)
      }
      return implementation?.(args, options) ?? ""
    })

    await expect(copyVolume(SOURCE, TARGET, { ownership: OWNER })).rejects.toThrow(
      /already in use/
    )

    expect(spawn).not.toHaveBeenCalled()
    expect(
      calls().some(
        (args) =>
          args[0] === "rm" &&
          args[1] === "-f" &&
          args.at(-1) === createHash("sha256").update(deterministicLease).digest("hex")
      )
    ).toBe(false)
    // Source is still released; only the pre-existing target lock remains untouched.
    expect(
      calls().some(
        (args) =>
          args[0] === "rm" &&
          [...fakeLeaseContainers.values()].every((lease) => args.at(-1) !== lease.id)
      )
    ).toBe(true)
  })

  it("still releases the source lease and reports failure if target lease cleanup fails", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeProcWithStderr(0) as never)
    const implementation = vi.mocked(execDockerSafe).getMockImplementation()
    const targetLeaseName = `wtb-target-lease-${createHash("sha1")
      .update(TARGET)
      .digest("hex")
      .slice(0, 12)}`
    const targetLeaseId = createHash("sha256").update(targetLeaseName).digest("hex")
    vi.mocked(execDockerSafe).mockImplementation((args: string[], options) => {
      if (args[0] === "rm" && args[1] === "-f" && args.at(-1) === targetLeaseId) {
        throw new Error("cannot remove target lease")
      }
      return implementation?.(args, options) ?? ""
    })

    await expect(copyVolume(SOURCE, TARGET, { ownership: OWNER })).rejects.toThrow(
      /cannot remove target lease/
    )

    const seq = calls()
    const failedTargetRelease = seq.findIndex(
      (args) => args[0] === "rm" && args.at(-1) === targetLeaseId
    )
    const sourceRelease = seq.findIndex(
      (args) =>
        args[0] === "rm" && args.at(-1) !== targetLeaseId
    )
    expect(failedTargetRelease).toBeGreaterThanOrEqual(0)
    expect(sourceRelease).toBeGreaterThan(failedTargetRelease)
  })
})

describe("target lifecycle leases", () => {
  const TARGET = "lifecycle_target"
  const OWNER = { repo: "repo123", project: "target_proj", branch: "feature/test" }
  const DU_CMD =
    'if [ -z "$(find /data -mindepth 1 -print -quit)" ]; then echo 0; else tar -C /data -cf - . | wc -c; fi'

  it("re-probes emptiness after acquiring the running lease", () => {
    vi.clearAllMocks()
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args[0] === "volume" && args[1] === "ls") return ""
      if (args[0] === "volume" && args[1] === "inspect" && args.includes("{{json .}}")) {
        return volumeInspection({
          "wtb.managed": "true",
          "wtb.repo": OWNER.repo,
          "wtb.project": OWNER.project,
          "wtb.branch": OWNER.branch,
        })
      }
      if (args.includes(DU_CMD)) return "1"
      return handleFakeLeaseDocker(args) ?? ""
    })

    expect(() =>
      acquireTargetVolumeLifecycleLeases([TARGET], OWNER, { requireEmpty: true })
    ).toThrow(/gained data before its seed lease/)
    expect(
      [...fakeLeaseContainers.values()].some(
        (lease) => lease.kind === "target" && lease.volume === TARGET
      )
    ).toBe(false)
  })
})

describe("volume clone operation lock", () => {
  const REPO = "repo123"
  const SOURCE_PROJECT = "main_project"

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      return handleFakeLeaseDocker(args) ?? ""
    })
  })

  it("uses a deterministic running container and removes the exact id on release", () => {
    const lock = acquireVolumeCloneOperationLock(REPO, SOURCE_PROJECT)
    const stored = [...fakeLeaseContainers.values()].find((entry) => entry.kind === "clone")
    expect(stored).toMatchObject({
      name: lock.containerName,
      repo: REPO,
      sourceProject: SOURCE_PROJECT,
      running: true,
    })
    expect(
      vi.mocked(execDockerSafe).mock.calls.some(
        ([args]) =>
          args[0] === "run" &&
          args.includes("--detach") &&
          args.includes("wtb.lock=volume-clone")
      )
    ).toBe(true)

    lock.release()
    expect(fakeLeaseContainers.has(stored?.id ?? "")).toBe(false)
    expect(
      vi.mocked(execDockerSafe).mock.calls.some(
        ([args]) => args[0] === "rm" && args[1] === "-f" && args.at(-1) === stored?.id
      )
    ).toBe(true)
  })

  it("rejects a stopped deterministic lock and never auto-removes it", () => {
    const first = acquireVolumeCloneOperationLock(REPO, SOURCE_PROJECT)
    const stored = [...fakeLeaseContainers.values()].find((entry) => entry.kind === "clone")
    if (!stored) throw new Error("test clone lock was not created")
    stored.running = false
    vi.mocked(execDockerSafe).mockClear()

    expect(() => acquireVolumeCloneOperationLock(REPO, SOURCE_PROJECT)).toThrow(
      /Unresolved stopped clone-operation lock/
    )
    expect(fakeLeaseContainers.has(stored.id)).toBe(true)
    expect(
      vi.mocked(execDockerSafe).mock.calls.some(
        ([args]) => args[0] === "rm" && args.at(-1) === stored.id
      )
    ).toBe(false)

    // Do not call first.release(): strict release correctly rejects a stopped stale lock.
    expect(first.containerName).toBe(stored.name)
  })
})

describe("getContainersUsingVolumeWithProject", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("parses tab-separated name + compose project label", () => {
    vi.mocked(execDockerSafe).mockReturnValue("api-1\tmyproj\ndb-1\tmyproj")
    expect(getContainersUsingVolumeWithProject("vol")).toEqual([
      { name: "api-1", project: "myproj" },
      { name: "db-1", project: "myproj" },
    ])
  })

  it("maps a missing label (no tab) to project: null", () => {
    vi.mocked(execDockerSafe).mockReturnValue("standalone-container")
    expect(getContainersUsingVolumeWithProject("vol")).toEqual([
      { name: "standalone-container", project: null },
    ])
  })

  it("maps an empty label (trailing tab) to project: null", () => {
    vi.mocked(execDockerSafe).mockReturnValue("c1\t")
    expect(getContainersUsingVolumeWithProject("vol")).toEqual([{ name: "c1", project: null }])
  })

  it("returns [] for empty output", () => {
    vi.mocked(execDockerSafe).mockReturnValue("")
    expect(getContainersUsingVolumeWithProject("vol")).toEqual([])
  })

  it("ignores blank lines", () => {
    vi.mocked(execDockerSafe).mockReturnValue("a\tp1\n\n\nb\tp2\n")
    expect(getContainersUsingVolumeWithProject("vol")).toEqual([
      { name: "a", project: "p1" },
      { name: "b", project: "p2" },
    ])
  })

  it("returns [] when execDockerSafe throws (error-swallowing like getContainersUsingVolume)", () => {
    vi.mocked(execDockerSafe).mockImplementation(() => {
      throw new Error("docker down")
    })
    expect(getContainersUsingVolumeWithProject("vol")).toEqual([])
  })
})
