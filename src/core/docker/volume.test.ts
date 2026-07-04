import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ComposeConfig } from "../../types/index.js"
import { execDockerSafe } from "../../utils/exec.js"
import {
  copyVolume,
  copyVolumeWithRsync,
  createVolume,
  discoverCloneableVolumes,
  formatBytes,
  formatEta,
  getContainersUsingVolumeWithProject,
  parseRsyncProgress,
  resolveVolumeName,
} from "./volume"

vi.mock("../../utils/exec.js", () => ({ execDockerSafe: vi.fn(() => "") }))
vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

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
  const DU_CMD = "du -sb /data 2>/dev/null | cut -f1"
  const CLEAR_CMD = "find /target -mindepth 1 -delete"
  const CP_CMD = "cp -a /source/. /target/"

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
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    // staging-failure tests deliberately fail rsync → copyVolume logs a
    // "rsync copy failed, falling back to cp" warning. Silence it for clean output.
    vi.spyOn(console, "warn").mockImplementation(() => {})
    // default: rsync succeeds; source & temp both non-empty
    vi.mocked(spawn).mockImplementation(() => fakeRsyncProc(0) as never)
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args.includes(DU_CMD)) {
        const vol = mountVol(args, ":/data:ro")
        return vol === SOURCE || vol.includes("__wtbtmp_") ? "100" : "0"
      }
      return ""
    })
  })

  it("stages into a temp volume, then clears+refills the target, then removes the temp", async () => {
    await copyVolume(SOURCE, TARGET, { clearTarget: true })

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

    // target is cleared and refilled from the verified temp, then temp removed last
    expect(clearIdx).toBeGreaterThanOrEqual(0)
    expect(refillIdx).toBeGreaterThan(clearIdx)
    expect(rmIdx).toBeGreaterThan(refillIdx)
  })

  it("never clears the target when staging fails (existing target data preserved)", async () => {
    // rsync fails → cp fallback into the temp → make that cp blow up
    vi.mocked(spawn).mockImplementation(() => fakeRsyncProc(1) as never)
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args.includes(DU_CMD)) return "100"
      if (
        args.includes(CP_CMD) &&
        args.some((x) => x.includes("__wtbtmp_") && x.endsWith(":/target"))
      ) {
        throw new Error("cp into temp failed")
      }
      return ""
    })

    await expect(copyVolume(SOURCE, TARGET, { clearTarget: true })).rejects.toThrow()
    // the real target must be untouched, and the temp cleaned up
    expect(clearedTarget()).toBe(false)
    expect(removedTemp()).toBe(true)
  })

  it("aborts without clearing the target when the staged copy is empty", async () => {
    // rsync 'succeeds' but the temp ends up empty while source has data
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args.includes(DU_CMD)) {
        const vol = mountVol(args, ":/data:ro")
        return vol === SOURCE ? "100" : "0"
      }
      return ""
    })

    await expect(copyVolume(SOURCE, TARGET, { clearTarget: true })).rejects.toThrow(/empty/)
    expect(clearedTarget()).toBe(false)
    expect(removedTemp()).toBe(true)
  })

  it("uses the direct (non-atomic) path when clearTarget is not set", async () => {
    await copyVolume(SOURCE, TARGET, {})
    // no temp volume, no target clear — just a direct rsync into the target
    expect(tempName()).toBeUndefined()
    expect(clearedTarget()).toBe(false)
    expect(spawn).toHaveBeenCalled()
  })

  it("aborts without clearing the target when the volume-size probe fails", async () => {
    // du errors → getVolumeSize returns null. The verify gate must treat 'cannot
    // determine' as abort, NOT as 'empty', so the destructive commit never runs.
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args.includes(DU_CMD)) throw new Error("docker daemon hiccup")
      return ""
    })
    await expect(copyVolume(SOURCE, TARGET, { clearTarget: true })).rejects.toThrow(/probe failed/)
    expect(clearedTarget()).toBe(false)
    expect(removedTemp()).toBe(true)
  })

  it("preserves the staged temp volume when the commit fails mid-overwrite", async () => {
    // staging (rsync) + verify succeed, but the commit cp into the REAL target fails
    // (e.g. disk full). The target is now cleared/partial, so the verified copy in the
    // temp volume is the ONLY intact data and must NOT be deleted.
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args.includes(DU_CMD)) {
        const vol = mountVol(args, ":/data:ro")
        return vol === SOURCE || vol.includes("__wtbtmp_") ? "100" : "0"
      }
      if (args.includes(CP_CMD) && args.includes(`${TARGET}:/target`)) {
        throw new Error("disk full during commit")
      }
      return ""
    })

    await expect(copyVolume(SOURCE, TARGET, { clearTarget: true })).rejects.toThrow()
    // commit started (target was cleared) but the temp volume must be preserved
    expect(clearedTarget()).toBe(true)
    expect(removedTemp()).toBe(false)
    // and the user is told how to recover from the temp volume
    expect(logged()).toContain("preserved in temp volume")
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
  const DU_CMD = "du -sb /data 2>/dev/null | cut -f1"
  const CLEAR_CMD = "find /target -mindepth 1 -delete"
  const CP_CMD = "cp -a /source/. /target/"

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
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) =>
      args.includes(DU_CMD) ? "100" : ""
    )
  })

  it("folds rsync stderr into the thrown error so failures are diagnosable", async () => {
    vi.mocked(spawn).mockImplementation(
      () =>
        fakeProcWithStderr(23, "rsync: failed to set permissions: Operation not permitted") as never
    )
    await expect(copyVolumeWithRsync(SOURCE, TARGET)).rejects.toThrow(
      /exit code 23.*Operation not permitted/s
    )
  })

  it("cp fallback starts from a clean target after a partial rsync (non-atomic path)", async () => {
    // rsync fails partway → copyVolume falls back to cp. The fallback must clear the
    // target first to discard rsync's partial tree, reproducing --delete semantics.
    vi.mocked(spawn).mockImplementation(() => fakeProcWithStderr(1, "partial write") as never)

    await copyVolume(SOURCE, TARGET, {})

    const seq = calls()
    const clearIdx = seq.findIndex((a) => a.includes(CLEAR_CMD) && a.includes(`${TARGET}:/target`))
    const cpIdx = seq.findIndex(
      (a) =>
        a.includes(CP_CMD) && a.includes(`${SOURCE}:/source:ro`) && a.includes(`${TARGET}:/target`)
    )
    expect(clearIdx).toBeGreaterThanOrEqual(0)
    expect(cpIdx).toBeGreaterThan(clearIdx)
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
