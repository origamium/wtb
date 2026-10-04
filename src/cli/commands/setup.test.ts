import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "../../core/config/loader.js"
import {
  assertSetupNotInProgress,
  markSetupTornDown,
  readSetupState,
  writeSetupState,
} from "../../core/environment/setup-state.js"
import * as repository from "../../core/git/repository.js"
import * as worktrees from "../../core/git/worktree.js"
import type { WtbConfig } from "../../types/index.js"
import { CLIError } from "../../utils/error.js"
import { execGitSafe } from "../../utils/exec.js"
import { setJsonOutputMode } from "../../utils/output.js"
import { type AwaitResult, waitForWorktree } from "./await.js"
import { type EnvironmentSetupResult, prepareWorktreeEnvironment } from "./create.js"
import { setupCommand, setupWorktree } from "./setup.js"
import { type ComposeLifecycleResult, runWorktreeComposeLifecycle } from "./updown.js"

vi.mock("../../core/config/loader.js")
vi.mock("../../core/git/repository.js")
vi.mock("../../core/git/worktree.js", async (original) => ({
  ...(await original<typeof import("../../core/git/worktree.js")>()),
  getWorktreePath: vi.fn(),
  listWorktrees: vi.fn(),
}))
vi.mock("../../utils/exec.js")
vi.mock("./create.js", () => ({ prepareWorktreeEnvironment: vi.fn() }))
vi.mock("./doctor.js", () => ({ runRelocatabilityPreflight: vi.fn() }))
vi.mock("./updown.js", () => ({ runWorktreeComposeLifecycle: vi.fn() }))
vi.mock("./await.js", () => ({ waitForWorktree: vi.fn(), parseAwaitTimeout: Number }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const prepared: EnvironmentSetupResult = {
  envChanges: { PORT: { from: "3000", to: "3001" } },
  composePorts: {},
  composeIdentity: { containerNames: [] },
  composeValueChanges: [],
  volumeResult: { cloned: [], skipped: [], failed: [] },
  startCommandFailed: false,
  startCommandRan: false,
  composeFailed: false,
  setupIssues: { warnings: [], failures: [] },
  volumeFailures: 0,
  seedFailed: false,
  seedRan: false,
  sourceRestartFailed: false,
}

describe("setup preparation and activation coordination", () => {
  let root: string
  let source: string
  let target: string
  let config: WtbConfig
  let upResult: ComposeLifecycleResult
  let readyResult: AwaitResult
  let originalOrcaPath: string | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    originalOrcaPath = process.env.ORCA_WORKTREE_PATH
    delete process.env.ORCA_WORKTREE_PATH
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtb-setup-command-")))
    source = path.join(root, "main")
    target = path.join(root, "feature")
    fs.mkdirSync(source)
    fs.mkdirSync(target)
    config = {
      base_branch: "main",
      docker_compose_file: "compose.yml",
      copy_files: [],
      link_files: [],
      env: { file: [".env"], adjust: { PORT: 1 } },
      volumes: { exclude: [] },
    }
    vi.mocked(loadConfig).mockImplementation(() => config)
    vi.mocked(repository.getRepositoryContext).mockReturnValue({
      currentRoot: source,
      mainRoot: source,
      commonGitDir: path.join(source, ".git"),
    })
    vi.mocked(repository.acquireRepositoryLock).mockResolvedValue(
      vi.fn().mockResolvedValue(undefined)
    )
    vi.mocked(worktrees.getWorktreePath).mockReturnValue(target)
    vi.mocked(worktrees.listWorktrees).mockReturnValue([
      { branch: "main", path: source, head: "a" },
      { branch: "feature/x", path: target, head: "b" },
    ])
    vi.mocked(execGitSafe).mockImplementation((args) => {
      if (args[0] === "rev-parse") return path.join(root, "setup.json")
      if (args[0] === "diff" || args[0] === "ls-files") return ""
      throw new Error(`Unexpected Git invocation: ${args.join(" ")}`)
    })
    vi.mocked(prepareWorktreeEnvironment).mockImplementation(async (input) => {
      if (!input.options.dryRun) {
        input.onPhase?.("env")
        fs.writeFileSync(path.join(target, ".env"), "PORT=3001\n")
        fs.writeFileSync(path.join(target, "compose.yml"), "name: target-project\nservices: {}\n")
      }
      await input.releaseAllocationLock()
      return structuredClone(prepared)
    })
    upResult = {
      branch: "feature/x",
      path: target,
      composeFile: path.join(target, "compose.yml"),
      project: "target-project",
      action: "up",
      ok: true,
    }
    readyResult = {
      branch: "feature/x",
      path: target,
      composeFile: path.join(target, "compose.yml"),
      project: "target-project",
      ok: true,
      timedOut: false,
      elapsedMs: 10,
      services: [],
    }
    vi.mocked(runWorktreeComposeLifecycle).mockImplementation(async () => upResult)
    vi.mocked(waitForWorktree).mockImplementation(async () => readyResult)
    setJsonOutputMode(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalOrcaPath === undefined) delete process.env.ORCA_WORKTREE_PATH
    else process.env.ORCA_WORKTREE_PATH = originalOrcaPath
    fs.rmSync(root, { recursive: true, force: true })
    setJsonOutputMode(false)
  })

  it("prepares once and reuses verified files without repeating data/start work", async () => {
    const first = await setupWorktree("feature/x")
    expect(first).toMatchObject({ ok: true, prepared: true, reused: false })
    const state = readSetupState(target)
    expect(state).toMatchObject({ status: "complete", phase: "complete", branch: "feature/x" })
    expect(Object.keys(state?.artifacts ?? {}).sort()).toEqual([".env", "compose.yml"])
    const second = await setupWorktree("feature/x")
    expect(second).toMatchObject({ ok: true, prepared: true, reused: true, setup: null })
    expect(prepareWorktreeEnvironment).toHaveBeenCalledTimes(1)
  })

  it("refuses a complete record whose artifact list was truncated", async () => {
    expect((await setupWorktree("feature/x")).ok).toBe(true)
    const state = readSetupState(target)
    if (!state) throw new Error("Expected completed setup record")
    delete state.artifacts[".env"]
    writeSetupState(target, state)
    fs.writeFileSync(path.join(target, ".env"), "PORT=9999\n")

    const result = await setupWorktree("feature/x", { up: true })

    expect(result.ok).toBe(false)
    expect(prepareWorktreeEnvironment).toHaveBeenCalledTimes(1)
    expect(runWorktreeComposeLifecycle).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(target, ".env"), "utf8")).toBe("PORT=9999\n")
  })

  it("still emits one structured CLI error when releasing the setup lock fails", async () => {
    vi.mocked(repository.acquireRepositoryLock).mockResolvedValueOnce(
      vi.fn().mockRejectedValue(new Error("lock cleanup denied"))
    )
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      await expect(
        setupCommand().parseAsync(["feature/x", "--json"], { from: "user" })
      ).resolves.toBeDefined()
      expect(output).toHaveBeenCalledTimes(1)
      const result = JSON.parse(String(output.mock.calls[0][0]))
      expect(result).toMatchObject({ ok: false, exitCode: 1, branch: "feature/x", path: target })
      expect(result.error).toContain("Could not release setup lock: lock cleanup denied")
      expect(process.exitCode).toBe(1)
      expect(readSetupState(target)).toMatchObject({ status: "failed" })
      expect(fs.readFileSync(path.join(target, ".env"), "utf8")).toBe("PORT=3001\n")
    } finally {
      process.exitCode = undefined
    }
  })

  it("preserves an earlier failure and its exit code when lock release also fails", async () => {
    vi.mocked(repository.acquireRepositoryLock).mockResolvedValueOnce(
      vi.fn().mockRejectedValue(new Error("lock cleanup denied"))
    )
    vi.mocked(prepareWorktreeEnvironment).mockRejectedValueOnce(
      new CLIError("source recovery failed", 5)
    )

    const result = await setupWorktree("feature/x")

    expect(result).toMatchObject({ ok: false, exitCode: 5 })
    expect(result.error).toContain("source recovery failed")
    expect(result.error).toContain("Could not release setup lock: lock cleanup denied")
    expect(readSetupState(target)).toMatchObject({
      status: "failed",
      error: "source recovery failed",
    })
    expect(runWorktreeComposeLifecycle).not.toHaveBeenCalled()
  })

  it.each([
    false,
    true,
  ])("blocks teardown and concurrent setup while %s reused activation awaits up", async (reuse) => {
    if (reuse) expect((await setupWorktree("feature/x")).ok).toBe(true)
    const entered = deferred<void>()
    const gate = deferred<void>()
    vi.mocked(runWorktreeComposeLifecycle).mockImplementationOnce(async () => {
      entered.resolve()
      await gate.promise
      return upResult
    })
    const activation = setupWorktree("feature/x", { up: true })
    await entered.promise
    try {
      expect(readSetupState(target)).toMatchObject({
        status: "complete",
        phase: "up",
        pid: process.pid,
      })
      expect(() => assertSetupNotInProgress(target)).toThrow("Setup is still running")
      const concurrent = await setupWorktree("feature/x", { up: true })
      expect(concurrent.ok).toBe(false)
      expect(concurrent.error).toContain("Setup is still running")
      expect(runWorktreeComposeLifecycle).toHaveBeenCalledTimes(1)
    } finally {
      gate.resolve()
      await activation
    }
    expect((await activation).ok).toBe(true)
    expect(readSetupState(target)).toMatchObject({ status: "complete", phase: "complete" })
    expect(() => assertSetupNotInProgress(target)).not.toThrow()
    expect(prepareWorktreeEnvironment).toHaveBeenCalledTimes(1)
  })

  it("holds the activation guard until asynchronous readiness finishes", async () => {
    const entered = deferred<void>()
    const gate = deferred<void>()
    vi.mocked(waitForWorktree).mockImplementationOnce(async () => {
      entered.resolve()
      await gate.promise
      return readyResult
    })
    const activation = setupWorktree("feature/x", { wait: true, timeout: 2 })
    await entered.promise
    try {
      expect(readSetupState(target)).toMatchObject({ status: "complete", phase: "await" })
      expect(() => assertSetupNotInProgress(target)).toThrow("Setup is still running")
    } finally {
      gate.resolve()
      await activation
    }
    expect((await activation).ok).toBe(true)
    expect(waitForWorktree).toHaveBeenCalledWith("feature/x", { timeout: 2 })
    expect(() => assertSetupNotInProgress(target)).not.toThrow()
  })

  it("retains completed preparation after readiness failure so a retry only activates", async () => {
    vi.mocked(waitForWorktree).mockResolvedValueOnce({ ...readyResult, ok: false, timedOut: true })
    const failure = await setupWorktree("feature/x", { wait: true })
    expect(failure).toMatchObject({ ok: false, prepared: true, exitCode: 1 })
    expect(readSetupState(target)).toMatchObject({ status: "complete", phase: "complete" })
    const retry = await setupWorktree("feature/x", { wait: true })
    expect(retry).toMatchObject({ ok: true, reused: true })
    expect(prepareWorktreeEnvironment).toHaveBeenCalledTimes(1)
    expect(runWorktreeComposeLifecycle).toHaveBeenCalledTimes(2)
  })

  it("retains complete preparation and releases the guard after Compose startup throws", async () => {
    vi.mocked(runWorktreeComposeLifecycle).mockRejectedValueOnce(new Error("start failed"))
    const result = await setupWorktree("feature/x", { up: true })
    expect(result).toMatchObject({ ok: false, prepared: true, error: "start failed" })
    expect(readSetupState(target)).toMatchObject({ status: "complete", phase: "complete" })
    expect(() => assertSetupNotInProgress(target)).not.toThrow()
    expect((await setupWorktree("feature/x", { up: true })).reused).toBe(true)
    expect(prepareWorktreeEnvironment).toHaveBeenCalledTimes(1)
  })

  it.each([
    "configuration",
    "options",
    "files",
    "torn-down",
  ])("rejects reuse after %s change", async (change) => {
    expect((await setupWorktree("feature/x")).ok).toBe(true)
    if (change === "configuration") config = { ...config, base_branch: "release" }
    if (change === "files") fs.writeFileSync(path.join(target, ".env"), "PORT=9999\n")
    if (change === "torn-down") markSetupTornDown(target)
    const result = await setupWorktree("feature/x", change === "options" ? { start: false } : {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/changed|torn-down/)
    expect(prepareWorktreeEnvironment).toHaveBeenCalledTimes(1)
    expect(runWorktreeComposeLifecycle).not.toHaveBeenCalled()
  })

  it("preserves partially prepared files and failure phase rather than replaying setup", async () => {
    vi.mocked(prepareWorktreeEnvironment).mockImplementationOnce(async (input) => {
      input.onPhase?.("env")
      fs.writeFileSync(path.join(target, ".env"), "PARTIAL=keep\n")
      await input.releaseAllocationLock()
      return {
        ...structuredClone(prepared),
        setupIssues: {
          warnings: [],
          failures: [{ phase: "env", path: ".env", message: "permission denied" }],
        },
      }
    })
    const failure = await setupWorktree("feature/x", { up: true })
    expect(failure).toMatchObject({ ok: false, exitCode: 1 })
    expect(failure.recovery).toContain("Setup was not replayed")
    expect(readSetupState(target)).toMatchObject({ status: "failed", phase: "env" })
    const retry = await setupWorktree("feature/x", { up: true })
    expect(retry.ok).toBe(false)
    expect(prepareWorktreeEnvironment).toHaveBeenCalledTimes(1)
    expect(runWorktreeComposeLifecycle).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(target, ".env"), "utf8")).toBe("PARTIAL=keep\n")
  })

  it("records a cloned-source restart failure as exit 5 and preserves failed setup", async () => {
    vi.mocked(prepareWorktreeEnvironment).mockResolvedValueOnce({
      ...structuredClone(prepared),
      sourceRestartFailed: true,
    })
    const result = await setupWorktree("feature/x")
    expect(result).toMatchObject({ ok: false, exitCode: 5 })
    expect(readSetupState(target)).toMatchObject({ status: "failed", phase: "volumes" })
  })

  it("records whole copied roots and link identity without recursively recording shared dependencies", async () => {
    config = { ...config, copy_files: ["config", "config/nested"], link_files: ["node_modules"] }
    fs.mkdirSync(path.join(source, "node_modules"))
    vi.mocked(prepareWorktreeEnvironment).mockImplementationOnce(async (input) => {
      fs.mkdirSync(path.join(target, "config", "nested"), { recursive: true })
      fs.writeFileSync(path.join(target, "config", "nested", "settings"), "original")
      fs.symlinkSync(path.join(source, "node_modules"), path.join(target, "node_modules"))
      await input.releaseAllocationLock()
      return structuredClone(prepared)
    })
    expect((await setupWorktree("feature/x")).ok).toBe(true)
    expect(Object.keys(readSetupState(target)?.artifacts ?? {}).sort()).toEqual([
      ".env",
      "compose.yml",
      "config",
      "node_modules",
    ])
    fs.writeFileSync(path.join(source, "node_modules", "dependency"), "updated")
    expect((await setupWorktree("feature/x")).ok).toBe(true)
    fs.writeFileSync(path.join(target, "config", "nested", "settings"), "edited")
    expect((await setupWorktree("feature/x")).ok).toBe(false)
    expect(prepareWorktreeEnvironment).toHaveBeenCalledTimes(1)
  })

  it("rejects an overflowing readiness timeout before preparing files or creating a record", async () => {
    const result = await setupWorktree("feature/x", { wait: true, timeout: Number.MAX_VALUE })
    expect(result).toMatchObject({ ok: false, prepared: false, exitCode: 2 })
    expect(prepareWorktreeEnvironment).not.toHaveBeenCalled()
    expect(repository.acquireRepositoryLock).not.toHaveBeenCalled()
    expect(readSetupState(target)).toBeNull()
  })

  it("dry-run never creates a marker or activates services", async () => {
    const result = await setupWorktree("feature/x", { dryRun: true, wait: true })
    expect(result).toMatchObject({ ok: true, dryRun: true, prepared: false })
    expect(readSetupState(target)).toBeNull()
    expect(runWorktreeComposeLifecycle).not.toHaveBeenCalled()
    expect(waitForWorktree).not.toHaveBeenCalled()
    expect(fs.readdirSync(target)).toEqual([])
  })
})
