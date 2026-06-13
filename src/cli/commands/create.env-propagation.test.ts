/**
 * @fileoverview F2 env→env ポート伝播の WIRING テスト
 * applyEnvAdjustments の 2-pass 挙動を実ファイル (tmp dir) で検証する。
 * 純粋関数 (propagatePortsInValue / buildPortMap) のロジックは propagate.test.ts が
 * カバー済みなので、ここでは「どのファイルが処理されるか」「source→target の
 * chaining-safety」「config gating」「--json env への additive surfacing」を確認する。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WtbConfig } from "../../types/index.js"
import { applyEnvAdjustments } from "./create"

vi.mock("../../core/git/worktree.js", () => ({
  listWorktrees: vi.fn(() => []),
  getWorktreePath: vi.fn(),
  createWorktree: vi.fn(),
  markWtbManagedFile: vi.fn(),
}))
vi.mock("../../core/docker/client.js", () => ({
  getUsedPorts: vi.fn(() => []),
}))

const config = (overrides: Partial<WtbConfig["env"]> = {}): WtbConfig =>
  ({
    base_branch: "main",
    copy_files: [],
    link_files: [],
    env: {
      file: [".env"],
      adjust: { KONG_HTTP_PORT: 0 }, // number marker = port bump
      port_propagation: { enabled: true, files: [], compose: false },
      ...overrides,
    },
    volumes: { exclude: [] },
  }) as unknown as WtbConfig

describe("applyEnvAdjustments — env→env port propagation (pass 2)", () => {
  let sourceRoot: string
  let targetRoot: string

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    sourceRoot = mkdtempSync(path.join(tmpdir(), "wtb-src-"))
    targetRoot = mkdtempSync(path.join(tmpdir(), "wtb-tgt-"))
  })

  afterEach(() => {
    rmSync(sourceRoot, { recursive: true, force: true })
    rmSync(targetRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const writeSource = (rel: string, content: string) => {
    writeFileSync(path.join(sourceRoot, rel), content)
  }
  const readTarget = (rel: string) => readFileSync(path.join(targetRoot, rel), "utf8")

  it("propagates a bumped port into a non-adjusted URL key in the same file", async () => {
    writeSource(".env", "KONG_HTTP_PORT=54321\nAPI_URL=http://localhost:54321\n")
    const changes = await applyEnvAdjustments(sourceRoot, targetRoot, config())

    const written = readTarget(".env")
    // KONG_HTTP_PORT was directly bumped (54321 → 54322 since nothing else used).
    expect(written).toContain("KONG_HTTP_PORT=54322")
    // API_URL (NOT in env.adjust) follows via propagation.
    expect(written).toContain("API_URL=http://localhost:54322")

    // --json env surfaces both the direct bump AND the propagated key (additive).
    expect(changes.KONG_HTTP_PORT).toEqual({ from: "54321", to: "54322" })
    expect(changes.API_URL).toEqual({
      from: "http://localhost:54321",
      to: "http://localhost:54322",
    })
  })

  it("does NOT propagate when port_propagation.enabled is false (pass 2 disabled)", async () => {
    writeSource(".env", "KONG_HTTP_PORT=54321\nAPI_URL=http://localhost:54321\n")
    const changes = await applyEnvAdjustments(
      sourceRoot,
      targetRoot,
      config({ port_propagation: { enabled: false, files: [], compose: false } })
    )

    const written = readTarget(".env")
    expect(written).toContain("KONG_HTTP_PORT=54322") // direct bump still happens
    expect(written).toContain("API_URL=http://localhost:54321") // NOT propagated
    expect(changes.API_URL).toBeUndefined()
  })

  it("does not double-map across files (chaining-safety: derive from SOURCE, not target)", async () => {
    // A bumps 54321→54322; B bumps 54322→54323. A non-adjusted URL holding :54322
    // in the SOURCE must map to 54323 (B's rule), NOT be re-derived from A's rewrite.
    writeSource("a.env", "PORT_A=54321\n")
    writeSource("b.env", "PORT_B=54322\nLINK=http://localhost:54322\n")
    const changes = await applyEnvAdjustments(sourceRoot, targetRoot, {
      base_branch: "main",
      copy_files: [],
      link_files: [],
      env: {
        file: ["a.env", "b.env"],
        adjust: { PORT_A: 0, PORT_B: 0 },
        port_propagation: { enabled: true, files: [], compose: false },
      },
      volumes: { exclude: [] },
    } as unknown as WtbConfig)

    // PORT_A: 54321 free → 54322? No: 54322 is taken by PORT_B in another file via
    // collectWorktreeEnvPorts? listWorktrees is mocked empty, so within-run the
    // copyAndAdjustEnvFile usedPorts accumulate across files. PORT_A bumps to the
    // next free above 54321; PORT_B (54322) is seen as used so PORT_A skips it.
    // The load-bearing assertion: LINK (source :54322) maps to PORT_B's new value,
    // derived from the single-pass map off SOURCE text — never 54321's chain.
    const linkLine = readTarget("b.env")
      .split("\n")
      .find((l) => l.startsWith("LINK="))
    const portB = changes.PORT_B?.to
    expect(portB).toBeDefined()
    expect(linkLine).toBe(`LINK=http://localhost:${portB}`)
    // It must NOT have been mapped to PORT_A's target (no A→B chaining).
    expect(linkLine).not.toBe(`LINK=http://localhost:${changes.PORT_A?.to}`)
  })

  it("M7: same adjust key in two files propagates per-file (no shared last-write-wins map)", async () => {
    // 同じ key (APP_PORT) が 2 つの env.file に現れ、それぞれ別の値へ bump する。
    // 各ファイルに埋め込まれた APP_PORT 参照 (LINK) は、そのファイル自身の bump に
    // 従うこと。flat な last-write-wins map だと file A の LINK が file B の値に
    // 誤伝播していた (M7 のバグ)。
    // usedPorts に source の両ポートを入れて確実に bump させる。
    const clientModule = await import("../../core/docker/client.js")
    vi.mocked(clientModule.getUsedPorts).mockReturnValue([3000, 8080])

    writeSource("a.env", "APP_PORT=3000\nLINK=http://localhost:3000\n")
    writeSource("b.env", "APP_PORT=8080\nLINK=http://localhost:8080\n")
    await applyEnvAdjustments(sourceRoot, targetRoot, {
      base_branch: "main",
      copy_files: [],
      link_files: [],
      env: {
        file: ["a.env", "b.env"],
        adjust: { APP_PORT: 0 },
        port_propagation: { enabled: true, files: [], compose: false },
      },
      volumes: { exclude: [] },
    } as unknown as WtbConfig)

    const aLink = readTarget("a.env")
      .split("\n")
      .find((l) => l.startsWith("LINK="))
    const bLink = readTarget("b.env")
      .split("\n")
      .find((l) => l.startsWith("LINK="))

    // a.env の APP_PORT 3000 → 3001 (3000 is used). a.env の LINK は a.env の bump に従う。
    expect(aLink).toBe("LINK=http://localhost:3001")
    // b.env の APP_PORT 8080 → 8081. b.env の LINK は b.env の bump に従う。
    expect(bLink).toBe("LINK=http://localhost:8081")
    // クロス汚染していないこと: a.env の LINK が b.env の値 (8081) になっていない。
    expect(aLink).not.toContain("8081")
    expect(bLink).not.toContain("3001")
  })

  it("copies + propagates a propagation-only file (in port_propagation.files, not env.file)", async () => {
    writeSource(".env", "KONG_HTTP_PORT=54321\n")
    writeSource("extra.env", "OTHER_URL=http://localhost:54321\n")
    const changes = await applyEnvAdjustments(
      sourceRoot,
      targetRoot,
      config({
        file: [".env"],
        adjust: { KONG_HTTP_PORT: 0 },
        port_propagation: { enabled: true, files: ["extra.env"], compose: false },
      })
    )

    // extra.env was NOT in env.file → must still be copied into the worktree, then
    // receive propagation (but NOT the env.adjust bump).
    const extra = readTarget("extra.env")
    expect(extra).toContain("OTHER_URL=http://localhost:54322")
    expect(changes.OTHER_URL).toEqual({
      from: "http://localhost:54321",
      to: "http://localhost:54322",
    })
  })
})
