/**
 * @fileoverview docker/client.ts のユニットテスト
 * execSync をモックし、docker ps / volume ls 出力のパースとエラー耐性を検証する
 */

import { execSync } from "node:child_process"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  getRunningContainers,
  getUsedPorts,
  getUsedPortsOrThrow,
  getWtbManagedVolumeNames,
  getWtbManagedVolumeNamesOrThrow,
} from "./client.js"

vi.mock("node:child_process", () => ({ execSync: vi.fn() }))

const execSyncMock = vi.mocked(execSync)

beforeEach(() => {
  execSyncMock.mockReset()
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

describe("getRunningContainers", () => {
  it("parses tab-separated multi-line docker ps output", () => {
    execSyncMock.mockReturnValue(
      [
        "abc123\tweb\tnginx:latest\tUp 5 minutes\t0.0.0.0:3000->80/tcp",
        "def456\tdb\tpostgres:16\tUp 2 hours\t",
      ].join("\n")
    )

    const containers = getRunningContainers()

    expect(containers).toEqual([
      {
        id: "abc123",
        name: "web",
        image: "nginx:latest",
        status: "Up 5 minutes",
        ports: ["0.0.0.0:3000->80/tcp"],
      },
      {
        id: "def456",
        name: "db",
        image: "postgres:16",
        status: "Up 2 hours",
        ports: [],
      },
    ])
  })

  it("skips short/malformed lines", () => {
    execSyncMock.mockReturnValue(
      ["abc123\tweb\tnginx:latest\tUp 5 minutes\t80/tcp", "garbage-line", "id\tname-only"].join(
        "\n"
      )
    )

    const containers = getRunningContainers()

    expect(containers).toHaveLength(1)
    expect(containers[0].name).toBe("web")
  })

  it("returns [] for empty output", () => {
    execSyncMock.mockReturnValue("")
    expect(getRunningContainers()).toEqual([])
  })

  it("returns [] without crashing when execSync throws", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("docker daemon not running")
    })
    expect(getRunningContainers()).toEqual([])
  })
})

describe("getUsedPorts", () => {
  it("dedupes IPv4/IPv6 mappings of the same host port", () => {
    execSyncMock.mockReturnValue("abc123\tweb\tnginx\tUp\t0.0.0.0:3000->80/tcp, :::3000->80/tcp")
    expect(getUsedPorts()).toEqual([3000])
  })

  it("returns sorted union across multiple containers", () => {
    execSyncMock.mockReturnValue(
      [
        "abc123\tweb\tnginx\tUp\t0.0.0.0:8080->80/tcp",
        "def456\tdb\tpostgres\tUp\t0.0.0.0:5432->5432/tcp, :::5432->5432/tcp",
        "ghi789\tapp\tnode\tUp\t0.0.0.0:3000->3000/tcp",
      ].join("\n")
    )
    expect(getUsedPorts()).toEqual([3000, 5432, 8080])
  })

  it("expands published IPv4 and bracketed IPv6 host ranges", () => {
    execSyncMock.mockReturnValue(
      "abc123\tweb\tnginx\tUp\t0.0.0.0:3000-3002->80-82/tcp, [::]:3000-3002->80-82/tcp"
    )
    expect(getUsedPorts()).toEqual([3000, 3001, 3002])
  })

  it("counts unpublished container ports as used", () => {
    // ponytail: unpublished container port counted as used — over-conservative false positive; require "->" in the regex only if it ever bites.
    execSyncMock.mockReturnValue("abc123\tweb\tnginx\tUp\t80/tcp")
    expect(getUsedPorts()).toEqual([80])
  })

  it("strictly propagates Docker daemon failures for allocation callers", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("docker daemon not running")
    })
    expect(() => getUsedPortsOrThrow()).toThrow(/Docker command failed/)
  })
})

describe("getWtbManagedVolumeNames", () => {
  it("includes both label filters for a valid hex repoLabel", () => {
    execSyncMock.mockReturnValue("wtb-vol-1\nwtb-vol-2")

    const names = getWtbManagedVolumeNames("abc123def")

    expect(names).toEqual(["wtb-vol-1", "wtb-vol-2"])
    const command = execSyncMock.mock.calls[0][0] as string
    expect(command).toContain("label=wtb.managed=true")
    expect(command).toContain("label=wtb.repo=abc123def")
  })

  it("falls back to managed-only filter for a non-hex label", () => {
    execSyncMock.mockReturnValue("wtb-vol-1")

    const names = getWtbManagedVolumeNames("not-hex!; rm -rf /")

    expect(names).toEqual(["wtb-vol-1"])
    const command = execSyncMock.mock.calls[0][0] as string
    expect(command).toContain("label=wtb.managed=true")
    expect(command).not.toContain("wtb.repo")
  })

  it("returns [] on error", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("docker daemon not running")
    })
    expect(getWtbManagedVolumeNames("abc123")).toEqual([])
  })

  it("strict enumeration propagates Docker failures for destructive callers", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("docker daemon not running")
    })
    expect(() => getWtbManagedVolumeNamesOrThrow("abc123")).toThrow(/Docker command failed/)
  })
})
