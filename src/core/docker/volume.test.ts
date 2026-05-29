import { EventEmitter } from "node:events"
import { spawn } from "node:child_process"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ComposeConfig } from "../../types/index.js"
import { execDockerSafe } from "../../utils/exec.js"
import {
  copyVolume,
  discoverCloneableVolumes,
  formatBytes,
  formatEta,
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

  beforeEach(() => {
    vi.clearAllMocks()
    // default: rsync succeeds; source & temp both non-empty
    vi.mocked(spawn).mockImplementation(() => fakeRsyncProc(0) as never)
    vi.mocked(execDockerSafe).mockImplementation((args: string[]) => {
      if (args.includes(DU_CMD)) {
        const vol = mountVol(args, ":/data")
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
      (a) => a.includes(CP_CMD) && a.includes(`${tmp}:/source:ro`) && a.includes(`${TARGET}:/target`)
    )
    const rmIdx = seq.findIndex((a) => a[0] === "volume" && a[1] === "rm" && a.includes(tmp as string))

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
        const vol = mountVol(args, ":/data")
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
})
