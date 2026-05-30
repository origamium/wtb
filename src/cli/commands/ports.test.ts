/**
 * @fileoverview gatherPortsForWorktree のユニットテスト
 *
 * `wtb ports` は coding agent が最も多用するコマンド。e2e でも検証しているが、
 * ここでは gather ロジックの細部（adjust キー以外を漏らさない / compose を worktree
 * 優先・source フォールバックで解決 / endpoints の重複排除 / Docker 不在時の degrade）
 * を高速・粒度細かく固定する。parsePortMapping は実関数を使う（partial mock）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import * as composeModule from "../../core/docker/compose.js"
import * as envModule from "../../core/environment/processor.js"
import type { ComposeConfig, WorktreeInfo, WtbConfig } from "../../types/index.js"
import { gatherPortsForWorktree } from "./ports.js"

vi.mock("node:fs", () => ({
  accessSync: vi.fn(),
  constants: { R_OK: 4 },
}))
vi.mock("../../core/environment/processor.js", () => ({ parseEnvFile: vi.fn() }))
vi.mock("../../core/docker/compose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/docker/compose.js")>()
  return { ...actual, readComposeFile: vi.fn(), findComposeFile: vi.fn() }
})

import { accessSync } from "node:fs"

const WT: WorktreeInfo = { path: "/repo/wt", branch: "feature/x", head: "abc123" }

const cfg = (over: Partial<WtbConfig> = {}): WtbConfig => ({
  base_branch: "main",
  docker_compose_file: "docker-compose.yml",
  copy_files: [],
  link_files: [],
  env: { file: ["./.env"], adjust: { APP_PORT: 1, DB_PORT: 1 } },
  volumes: { exclude: [] },
  ...over,
})

const compose = (services: Record<string, unknown>): ComposeConfig =>
  ({ services }) as ComposeConfig

beforeEach(() => {
  vi.clearAllMocks()
  // default: env has an adjust key plus a secret; compose readable in the worktree
  vi.mocked(envModule.parseEnvFile).mockReturnValue({
    lines: [],
    entries: [
      { key: "APP_PORT", value: "3001" },
      { key: "DB_PORT", value: "5433" },
      { key: "SECRET_KEY", value: "do-not-leak" },
    ],
    originalContent: "",
  })
  vi.mocked(accessSync).mockReturnValue(undefined) // every path readable
  vi.mocked(composeModule.readComposeFile).mockReturnValue(
    compose({ web: { ports: ["3001:80"] }, db: { ports: ["5433:5432"] } })
  )
})

describe("gatherPortsForWorktree", () => {
  it("surfaces only env.adjust keys (never leaks other .env entries)", () => {
    const r = gatherPortsForWorktree(WT, "/repo", cfg())
    expect(r.env).toEqual({ APP_PORT: "3001", DB_PORT: "5433" })
    expect(r.env.SECRET_KEY).toBeUndefined()
    expect(r.branch).toBe("feature/x")
  })

  it("parses compose host/container ports and builds localhost endpoints", () => {
    const r = gatherPortsForWorktree(WT, "/repo", cfg())
    expect(r.compose.services.web.host_ports).toEqual([3001])
    expect(r.compose.services.web.container_ports).toEqual([80])
    expect(r.compose.services.db.host_ports).toEqual([5433])
    expect(r.endpoints).toContain("http://localhost:3001")
    expect(r.endpoints).toContain("http://localhost:5433")
  })

  it("dedupes endpoints when services share a host port", () => {
    vi.mocked(composeModule.readComposeFile).mockReturnValue(
      compose({ a: { ports: ["3001:80"] }, b: { ports: ["3001:81"] } })
    )
    const r = gatherPortsForWorktree(WT, "/repo", cfg())
    expect(r.endpoints).toEqual(["http://localhost:3001"])
  })

  it("prefers the worktree's compose copy over the source's", () => {
    // worktree path readable → source must not be consulted
    gatherPortsForWorktree(WT, "/repo", cfg())
    const composePathUsed = vi.mocked(composeModule.readComposeFile).mock.calls[0][0]
    expect(composePathUsed).toContain("/repo/wt/")
  })

  it("falls back to the source compose when the worktree has none", () => {
    // only the gitRoot copy is readable
    vi.mocked(accessSync).mockImplementation((p) => {
      if (String(p).startsWith("/repo/wt/")) throw new Error("ENOENT")
      return undefined
    })
    gatherPortsForWorktree(WT, "/repo", cfg())
    const composePathUsed = vi.mocked(composeModule.readComposeFile).mock.calls[0][0]
    expect(composePathUsed).toContain("/repo/docker-compose.yml")
  })

  it("degrades to empty compose when Docker/compose is absent", () => {
    vi.mocked(accessSync).mockImplementation(() => {
      throw new Error("ENOENT")
    })
    vi.mocked(composeModule.findComposeFile).mockReturnValue(null)
    const r = gatherPortsForWorktree(WT, "/repo", cfg({ docker_compose_file: "" }))
    expect(r.compose).toEqual({ file: null, services: {} })
    expect(r.endpoints).toEqual([])
    // env still works without Docker
    expect(r.env.APP_PORT).toBe("3001")
  })
})
