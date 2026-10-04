import { execFileSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "../../constants/index.js"
import { resolveWorktreeComposeContext } from "../../core/docker/worktree-context.js"
import { CLIError } from "../../utils/error.js"
import { awaitCommand, parseAwaitTimeout, waitForWorktree } from "./await.js"

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(), execSync: vi.fn() }))
vi.mock("../../core/docker/worktree-context.js", () => ({ resolveWorktreeComposeContext: vi.fn() }))
vi.mock("../../core/docker/compose.js", () => ({
  loadComposeInterpolationEnvironment: () => ({}),
  assertNoComposeSourceOverrides: vi.fn(),
}))

const context = {
  repository: { mainRoot: "/repo", currentRoot: "/wt", commonGitDir: "/repo/.git" },
  worktreePath: "/wt",
  targetBranch: "feature",
  config: DEFAULT_CONFIG,
  composePath: "/wt/compose.yml",
  targetProject: "app-feature",
}
let previousExit: string | number | undefined
beforeEach(() => {
  previousExit = process.exitCode
  vi.clearAllMocks()
  vi.mocked(resolveWorktreeComposeContext).mockReturnValue(context)
  vi.mocked(execFileSync).mockImplementation((_file, args) => {
    if ((args as string[]).includes("config")) return JSON.stringify({ services: { web: {} } })
    return JSON.stringify([{ Service: "web", State: "running", Health: "" }])
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  process.exitCode = previousExit
})

describe("wtb await", () => {
  it("excludes completed Compose run one-offs from service replicas", async () => {
    vi.mocked(execFileSync).mockImplementation((_file, rawArgs) => {
      const args = rawArgs as string[]
      if (args.includes("config")) return JSON.stringify({ services: { web: {} } })
      if (args[0] === "inspect")
        return '{"com.docker.compose.oneoff":"False"}\n{"com.docker.compose.oneoff":"True"}'
      return JSON.stringify([
        { ID: "service", Service: "web", State: "running", Health: "" },
        { ID: "oneoff", Service: "web", State: "exited", Health: "", ExitCode: 1 },
      ])
    })
    const result = await waitForWorktree(undefined)
    expect(result.ok).toBe(true)
    expect(result.services[0].containers.map((row) => row.id)).toEqual(["service"])
  })

  it("returns readiness without printing or changing exitCode; bounds Docker calls", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true)
    const result = await waitForWorktree("feature", { timeout: 30 })
    expect(result).toMatchObject({
      branch: "feature",
      path: "/wt",
      project: "app-feature",
      ok: true,
      timedOut: false,
    })
    expect(write).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(previousExit)
    expect(resolveWorktreeComposeContext).toHaveBeenCalledWith("feature", "await", {
      runDocker: expect.any(Function),
    })
    expect(execFileSync).toHaveBeenCalledWith(
      "docker",
      ["compose", "-f", "/wt/compose.yml", "-p", "app-feature", "ps", "--all", "--format", "json"],
      expect.objectContaining({ cwd: "/wt", timeout: expect.any(Number), killSignal: "SIGKILL" })
    )
  })

  it("uses profile/config failures and Docker errors without false readiness", async () => {
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ services: {} }))
    await expect(waitForWorktree(undefined)).rejects.toMatchObject({ exitCode: 4 })
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("Docker unavailable")
    })
    await expect(waitForWorktree(undefined)).rejects.toMatchObject({ exitCode: 5 })
    vi.mocked(resolveWorktreeComposeContext).mockImplementation(() => {
      throw new CLIError("No docker_compose_file", 4)
    })
    await expect(waitForWorktree(undefined)).rejects.toMatchObject({ exitCode: 4 })
  })

  it("times out on missing services and keeps machine-readable diagnostics", async () => {
    vi.useFakeTimers()
    vi.mocked(execFileSync).mockImplementation((_file, args) =>
      (args as string[]).includes("config") ? JSON.stringify({ services: { web: {} } }) : "[]"
    )
    const pending = waitForWorktree(undefined, { timeout: 2 })
    await vi.advanceTimersByTimeAsync(2000)
    const result = await pending
    expect(result).toMatchObject({
      ok: false,
      timedOut: true,
      elapsedMs: 2000,
      services: [{ service: "web", ready: false, containers: [] }],
    })
  })

  it("classifies an exhausted Docker call as timeout and rejects malformed ps JSON", async () => {
    vi.useFakeTimers()
    vi.mocked(execFileSync).mockImplementation(() => {
      vi.setSystemTime(Date.now() + 1000)
      throw new Error("timed out")
    })
    await expect(waitForWorktree(undefined, { timeout: 1 })).resolves.toMatchObject({
      ok: false,
      timedOut: true,
    })
    vi.mocked(execFileSync).mockImplementation((_file, args) =>
      (args as string[]).includes("config")
        ? JSON.stringify({ services: { web: {} } })
        : "invalid json"
    )
    await expect(waitForWorktree(undefined)).rejects.toMatchObject({ exitCode: 5 })
  })

  it("outputs one JSON result and meaningful nonzero errors", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true)
    vi.spyOn(process.stderr, "write").mockReturnValue(true)
    await awaitCommand().parseAsync(["--json"], { from: "user" })
    expect(JSON.parse(String(write.mock.calls[0][0])).ok).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    write.mockClear()
    vi.mocked(resolveWorktreeComposeContext).mockImplementation(() => {
      throw new CLIError("not configured", 4)
    })
    await awaitCommand().parseAsync(["--json"], { from: "user" })
    expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual({
      ok: false,
      error: "not configured",
    })
    expect(process.exitCode).toBe(4)
  })

  it("validates timeout values before polling", async () => {
    for (const value of ["0", "-1", "NaN", "Infinity", "1second", "1e2", "9007199254740992"])
      expect(() => parseAwaitTimeout(value)).toThrow()
    expect(parseAwaitTimeout("0.5")).toBe(0.5)
    await expect(waitForWorktree(undefined, { timeout: -1 })).rejects.toMatchObject({ exitCode: 2 })
    expect(resolveWorktreeComposeContext).not.toHaveBeenCalled()
  })
})
