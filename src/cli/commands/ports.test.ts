/**
 * @fileoverview gatherPortsForWorktree のユニットテスト
 *
 * `wtb ports` は coding agent が最も多用するコマンド。e2e でも検証しているが、
 * ここでは gather ロジックの細部（adjust キー以外を漏らさない / compose を worktree
 * 優先・source フォールバックで解決 / endpoints の重複排除 / Docker 不在時の degrade）
 * を高速・粒度細かく固定する。parsePortMapping は実関数を使う（partial mock）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EXIT_CODES } from "../../constants/index.js"
import * as loaderModule from "../../core/config/loader.js"
import * as composeModule from "../../core/docker/compose.js"
import * as envMapModule from "../../core/environment/env-map.js"
import * as envModule from "../../core/environment/processor.js"
import * as repositoryModule from "../../core/git/repository.js"
import * as worktreeModule from "../../core/git/worktree.js"
import type { ComposeConfig, WorktreeInfo, WtbConfig } from "../../types/index.js"
import { gatherPortsForWorktree, portsCommand } from "./ports.js"

vi.mock("node:fs", () => ({
  accessSync: vi.fn(),
  constants: { R_OK: 4 },
}))
vi.mock("../../core/environment/processor.js", () => ({ parseEnvFile: vi.fn() }))
vi.mock("../../core/environment/env-map.js", () => ({ buildWorktreeEnvMap: vi.fn() }))
vi.mock("../../core/docker/compose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/docker/compose.js")>()
  return { ...actual, readComposeFile: vi.fn(), findComposeFile: vi.fn() }
})
vi.mock("../../core/config/loader.js")
vi.mock("../../core/git/repository.js")
vi.mock("../../core/git/worktree.js")

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
  vi.mocked(envMapModule.buildWorktreeEnvMap).mockReturnValue({
    APP_PORT: "3001",
    DB_PORT: "5433",
    SECRET_KEY: "do-not-leak",
  })
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

describe("ports command surface", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.mocked(repositoryModule.getGitRootOrThrow).mockReturnValue("/repo")
    vi.mocked(loaderModule.loadConfig).mockReturnValue(cfg())
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/repo", branch: "main", head: "abc" },
      WT,
    ])
  })

  afterEach(() => {
    writeSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it("exposes -a/--all, --pretty, and --json options", () => {
    const flags = portsCommand().options.map((o) => o.flags)
    expect(flags).toContain("-a, --all")
    expect(flags).toContain("--pretty")
    expect(flags).toContain("--json")
  })

  it("rejects --json combined with --pretty (commander conflict)", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const command = portsCommand().exitOverride()

    await expect(command.parseAsync(["--json", "--pretty"], { from: "user" })).rejects.toThrow(
      /cannot be used with/
    )
    stderrSpy.mockRestore()
  })

  it("accepts --json as a no-op: same JSON as the default output", async () => {
    await portsCommand().parseAsync([], { from: "user" })
    const bare = writeSpy.mock.calls.map((c) => c[0]).join("")
    writeSpy.mockClear()

    await portsCommand().parseAsync(["--json"], { from: "user" })
    const withJson = writeSpy.mock.calls.map((c) => c[0]).join("")

    expect(withJson).toBe(bare)
    expect(() => JSON.parse(withJson)).not.toThrow()
  })

  it("targets a specific worktree via the positional [branch] argument", async () => {
    await portsCommand().parseAsync(["feature/x"], { from: "user" })

    const output = writeSpy.mock.calls.map((c) => c[0]).join("")
    const parsed = JSON.parse(output)
    expect(parsed.branch).toBe("feature/x")
    expect(parsed.path).toBe("/repo/wt")
  })

  it("exits GENERAL_ERROR and lists worktrees on stderr for an unknown branch", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited")
    })

    await expect(portsCommand().parseAsync(["nope"], { from: "user" })).rejects.toThrow("exited")

    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
    expect(writeSpy).not.toHaveBeenCalled()
    const stderr = consoleErrorSpy.mock.calls.map((c) => c[0]).join("\n")
    expect(stderr).toContain("Available worktrees:")
    expect(stderr).toContain("No worktree found for branch 'nope'")
    exitSpy.mockRestore()
  })

  it("exits INVALID_USAGE when a branch argument is combined with --all", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited")
    })

    await expect(
      portsCommand().parseAsync(["feature/x", "--all"], { from: "user" })
    ).rejects.toThrow("exited")

    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.INVALID_USAGE)
    exitSpy.mockRestore()
  })
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

describe("gatherPortsForWorktree — interpolation", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional — describes compose interpolation syntax in test name
  it("resolves ${VAR:-default} using env value when set", () => {
    vi.mocked(envMapModule.buildWorktreeEnvMap).mockReturnValue({ APP_PORT: "3001" })
    vi.mocked(composeModule.readComposeFile).mockReturnValue(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      compose({ web: { ports: ["${APP_PORT:-8080}:80"] } })
    )
    const r = gatherPortsForWorktree(WT, "/repo", cfg())
    expect(r.compose.services.web.host_ports).toEqual([3001])
    expect(r.compose.services.web.container_ports).toEqual([80])
  })

  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional — describes compose interpolation syntax in test name
  it("resolves ${VAR:-default} using the default when env value is absent", () => {
    vi.mocked(envMapModule.buildWorktreeEnvMap).mockReturnValue({})
    vi.mocked(composeModule.readComposeFile).mockReturnValue(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      compose({ web: { ports: ["${APP_PORT:-8080}:80"] } })
    )
    const r = gatherPortsForWorktree(WT, "/repo", cfg())
    expect(r.compose.services.web.host_ports).toEqual([8080])
  })

  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional — describes compose interpolation syntax in test name
  it("skips unresolved ${MISSING} and writes warning to stderr, keeping stdout clean", () => {
    vi.mocked(envMapModule.buildWorktreeEnvMap).mockReturnValue({})
    vi.mocked(composeModule.readComposeFile).mockReturnValue(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      compose({ web: { ports: ["${MISSING_PORT}:80"] } })
    )
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const r = gatherPortsForWorktree(WT, "/repo", cfg())
    expect(r.compose.services.web.host_ports).toEqual([])
    // stderr should have the warning
    const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join("")
    expect(stderrOutput).toContain("MISSING_PORT")
    expect(stderrOutput).toContain("unresolved")
    // stdout was not written to by gatherPortsForWorktree
    expect(stdoutSpy).not.toHaveBeenCalled()
    stdoutSpy.mockRestore()
  })

  it("handles host-ip prefix in port string (127.0.0.1:3001:80)", () => {
    vi.mocked(envMapModule.buildWorktreeEnvMap).mockReturnValue({ APP_PORT: "3001" })
    vi.mocked(composeModule.readComposeFile).mockReturnValue(
      compose({ web: { ports: ["127.0.0.1:3001:80"] } })
    )
    const r = gatherPortsForWorktree(WT, "/repo", cfg())
    expect(r.compose.services.web.host_ports).toEqual([3001])
    expect(r.compose.services.web.container_ports).toEqual([80])
  })

  it("handles /udp suffix in port string (3001:53/udp)", () => {
    vi.mocked(envMapModule.buildWorktreeEnvMap).mockReturnValue({ APP_PORT: "3001" })
    vi.mocked(composeModule.readComposeFile).mockReturnValue(
      compose({ web: { ports: ["3001:53/udp"] } })
    )
    const r = gatherPortsForWorktree(WT, "/repo", cfg())
    expect(r.compose.services.web.host_ports).toEqual([3001])
    expect(r.compose.services.web.container_ports).toEqual([53])
  })

  it("handles long-syntax object port entries", () => {
    vi.mocked(envMapModule.buildWorktreeEnvMap).mockReturnValue({ APP_PORT: "3001" })
    vi.mocked(composeModule.readComposeFile).mockReturnValue(
      compose({
        web: {
          ports: [
            { target: 80, published: 3001, protocol: "tcp", mode: "host" },
          ],
        },
      })
    )
    const r = gatherPortsForWorktree(WT, "/repo", cfg())
    expect(r.compose.services.web.host_ports).toEqual([3001])
    expect(r.compose.services.web.container_ports).toEqual([80])
  })

  it("dedupes warning stderr messages for the same variable across multiple ports", () => {
    vi.mocked(envMapModule.buildWorktreeEnvMap).mockReturnValue({})
    vi.mocked(composeModule.readComposeFile).mockReturnValue(
      compose({
        web: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
          ports: ["${MISSING_PORT}:80", "${MISSING_PORT}:443"],
        },
      })
    )
    gatherPortsForWorktree(WT, "/repo", cfg())
    const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join("")
    // Should appear only once
    const count = (stderrOutput.match(/MISSING_PORT/g) ?? []).length
    expect(count).toBe(1)
  })
})
