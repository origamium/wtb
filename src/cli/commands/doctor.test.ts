/**
 * @fileoverview `wtb doctor` コマンドのユニットテスト
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EXIT_CODES } from "../../constants/index.js"
import * as loaderModule from "../../core/config/loader.js"
import * as composeModule from "../../core/docker/compose.js"
import * as locateModule from "../../core/docker/locate.js"
import * as envMapModule from "../../core/environment/env-map.js"
import * as repositoryModule from "../../core/git/repository.js"
import type { ComposeConfig, WtbConfig } from "../../types/index.js"
import { doctorCommand } from "./doctor.js"

vi.mock("../../core/config/loader.js")
vi.mock("../../core/git/repository.js")
vi.mock("../../core/docker/locate.js")
vi.mock("../../core/docker/compose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/docker/compose.js")>()
  return { ...actual, readComposeFile: vi.fn() }
})
vi.mock("../../core/environment/env-map.js")

const cfg = (over: Partial<WtbConfig> = {}): WtbConfig => ({
  base_branch: "main",
  docker_compose_file: "docker-compose.yml",
  copy_files: [],
  link_files: [],
  env: {
    file: [".env"],
    adjust: { APP_PORT: 1 },
    port_propagation: { enabled: false, files: [], compose: false },
  },
  volumes: { exclude: [] },
  ...over,
})

const compose = (over: Partial<ComposeConfig> = {}): ComposeConfig =>
  ({ services: {}, ...over }) as ComposeConfig

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(repositoryModule.getGitRootOrThrow).mockReturnValue("/repo")
  vi.mocked(loaderModule.loadConfig).mockReturnValue(cfg())
  vi.mocked(envMapModule.buildWorktreeEnvMap).mockReturnValue({ APP_PORT: "3001" })
  vi.mocked(locateModule.resolveComposePath).mockReturnValue("/repo/docker-compose.yml")
  vi.mocked(composeModule.readComposeFile).mockReturnValue(compose())
})

describe("doctor command surface", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    writeSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it("exposes --json and --strict options", () => {
    const flags = doctorCommand().options.map((o) => o.flags)
    expect(flags).toContain("--json")
    expect(flags).toContain("--strict")
  })

  it("outputs valid JSON when --json is passed", async () => {
    await doctorCommand().parseAsync(["--json"], { from: "user" })
    const output = writeSpy.mock.calls.map((c) => c[0]).join("")
    expect(() => JSON.parse(output)).not.toThrow()
    const parsed = JSON.parse(output)
    expect(parsed).toHaveProperty("ok")
    expect(parsed).toHaveProperty("findings")
    expect(parsed).toHaveProperty("summary")
  })

  it("JSON stdout contains no non-JSON content", async () => {
    await doctorCommand().parseAsync(["--json"], { from: "user" })
    const output = writeSpy.mock.calls.map((c) => c[0]).join("")
    // Should be parseable as JSON from start to end
    expect(() => JSON.parse(output.trim())).not.toThrow()
  })

  it("outputs pretty text by default (no --json)", async () => {
    await doctorCommand().parseAsync([], { from: "user" })
    const output = writeSpy.mock.calls.map((c) => c[0]).join("")
    // Pretty output must NOT be valid JSON
    expect(output).not.toMatch(/^\s*\{/)
    // Should contain human-readable indicator
    expect(output.length).toBeGreaterThan(0)
  })

  it("exits 0 with warnings present (no --strict)", async () => {
    // Give compose a fixed project name to trigger a warning
    vi.mocked(composeModule.readComposeFile).mockReturnValue(compose({ name: "myapp" }))
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited")
    })
    // Without --strict, should NOT throw/exit
    await expect(doctorCommand().parseAsync([], { from: "user" })).resolves.toBeDefined()
    expect(exitSpy).not.toHaveBeenCalled()
    exitSpy.mockRestore()
  })

  it("--strict exits 1 when findings include warnings", async () => {
    vi.mocked(composeModule.readComposeFile).mockReturnValue(compose({ name: "myapp" }))
    const originalExitCode = process.exitCode
    await doctorCommand().parseAsync(["--strict"], { from: "user" })
    expect(process.exitCode).toBe(EXIT_CODES.GENERAL_ERROR)
    process.exitCode = originalExitCode
  })

  it("--json --strict with findings sets exitCode=1 AND emits full valid JSON (B2)", async () => {
    // Simulate a compose with a fixed project name to trigger a warning finding
    vi.mocked(composeModule.readComposeFile).mockReturnValue(compose({ name: "myapp" }))
    const originalExitCode = process.exitCode
    await doctorCommand().parseAsync(["--json", "--strict"], { from: "user" })
    // exitCode must be set (not process.exit which would flush-race on pipes)
    expect(process.exitCode).toBe(EXIT_CODES.GENERAL_ERROR)
    // Full JSON must still have been written to stdout
    const output = writeSpy.mock.calls.map((c) => c[0]).join("")
    expect(() => JSON.parse(output.trim())).not.toThrow()
    const parsed = JSON.parse(output.trim())
    expect(parsed).toHaveProperty("ok", false)
    expect(parsed.findings.length).toBeGreaterThan(0)
    process.exitCode = originalExitCode
  })

  it("--strict does NOT set exitCode when report.ok=true (clean compose)", async () => {
    // Clean compose — no findings
    vi.mocked(composeModule.readComposeFile).mockReturnValue(compose())
    const originalExitCode = process.exitCode
    process.exitCode = 0
    await doctorCommand().parseAsync(["--strict"], { from: "user" })
    expect(process.exitCode).toBe(0)
    process.exitCode = originalExitCode
  })

  it("handles no-compose-file path gracefully", async () => {
    vi.mocked(locateModule.resolveComposePath).mockReturnValue(null)
    vi.mocked(loaderModule.loadConfig).mockReturnValue(
      cfg({ docker_compose_file: "" })
    )
    await doctorCommand().parseAsync(["--json"], { from: "user" })
    const output = writeSpy.mock.calls.map((c) => c[0]).join("")
    const parsed = JSON.parse(output)
    expect(parsed.findings[0].id).toBe("no-compose-file")
    expect(parsed.ok).toBe(true)
  })

  it("throws CLIError when configured compose is not found", async () => {
    vi.mocked(locateModule.resolveComposePath).mockReturnValue(null)
    // docker_compose_file is set but path not found
    vi.mocked(loaderModule.loadConfig).mockReturnValue(
      cfg({ docker_compose_file: "docker-compose.yml" })
    )
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited")
    })
    await expect(
      doctorCommand().parseAsync([], { from: "user" })
    ).rejects.toThrow("exited")
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.GENERAL_ERROR)
    exitSpy.mockRestore()
  })
})
