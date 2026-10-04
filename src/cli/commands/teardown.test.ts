import { existsSync } from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "../../core/config/loader.js"
import * as compose from "../../core/docker/compose.js"
import * as ownership from "../../core/docker/project-ownership.js"
import { readVolumeRecoveryRecords } from "../../core/docker/volume.js"
import { assertComposeVolumesSafeForRemoval } from "../../core/docker/volume-removal.js"
import { assertSetupNotInProgress, markSetupTornDown } from "../../core/environment/setup-state.js"
import * as repository from "../../core/git/repository.js"
import * as worktree from "../../core/git/worktree.js"
import { executeLifecycleCommand, withExecDeadline } from "../../utils/exec.js"
import { setJsonOutputMode } from "../../utils/output.js"
import { runWorktreeTeardown, teardownCommand } from "./teardown.js"

vi.mock("node:fs", () => ({ existsSync: vi.fn() }))
vi.mock("../../core/config/loader.js")
vi.mock("../../core/docker/compose.js")
vi.mock("../../core/docker/project-ownership.js")
vi.mock("../../core/docker/volume.js")
vi.mock("../../core/docker/volume-removal.js")
vi.mock("../../core/environment/setup-state.js")
vi.mock("../../core/git/repository.js")
vi.mock("../../core/git/worktree.js")
vi.mock("../../utils/exec.js", () => ({
  executeLifecycleCommand: vi.fn(),
  withExecDeadline: vi.fn((_timeoutMs, operation) => operation()),
}))

const target = "/worktrees/feature"
const config = {
  base_branch: "main",
  docker_compose_file: "compose.dev.yml",
  copy_files: [],
  link_files: [],
  end_command: "echo cleanup",
  env: { file: [], adjust: {} },
  volumes: { exclude: [] },
}

describe("teardown", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.mocked(existsSync).mockImplementation((value) => String(value).endsWith(".yml"))
    vi.mocked(repository.getRepositoryContext).mockReturnValue({
      currentRoot: "/repo",
      mainRoot: "/repo",
      commonGitDir: "/repo/.git",
    })
    vi.mocked(repository.acquireRepositoryLock).mockResolvedValue(
      vi.fn().mockResolvedValue(undefined)
    )
    vi.mocked(worktree.getWorktreePath).mockReturnValue(target)
    vi.mocked(worktree.canonicalPath).mockImplementation((value) => path.resolve(value))
    vi.mocked(worktree.isSamePath).mockImplementation((a, b) => path.resolve(a) === path.resolve(b))
    vi.mocked(worktree.listWorktrees).mockReturnValue([
      { path: "/repo", branch: "main", head: "a" },
      { path: target, branch: "feature/x", head: "b" },
    ])
    vi.mocked(loadConfig).mockReturnValue(config)
    vi.mocked(compose.safeResolveComposeProjectName).mockImplementation((_file, cwd) =>
      cwd === "/repo" ? "source-project" : "target-project"
    )
    vi.mocked(compose.readComposeFile).mockReturnValue({ services: {}, volumes: {} })
    vi.mocked(compose.withComposeSnapshot).mockImplementation((file, _config, operation) =>
      operation(file)
    )
    vi.mocked(assertComposeVolumesSafeForRemoval).mockReturnValue({ services: {}, volumes: {} })
    vi.mocked(readVolumeRecoveryRecords).mockReturnValue([])
    vi.mocked(executeLifecycleCommand).mockImplementation(() => {})
    vi.mocked(ownership.assertDockerComposeProjectOwnedByWorktree).mockImplementation(() => {})
    vi.mocked(markSetupTornDown).mockImplementation(() => {})
    vi.mocked(assertSetupNotInProgress).mockImplementation(() => {})
    process.exitCode = undefined
    setJsonOutputMode(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
    setJsonOutputMode(false)
  })

  it("validates ownership before end_command then removes residual owned resources", async () => {
    const result = await runWorktreeTeardown("feature/x", { removeVolumes: true })
    expect(ownership.assertDockerComposeProjectOwnedByWorktree).toHaveBeenCalledWith(
      "target-project",
      target,
      "compose.dev.yml"
    )
    expect(vi.mocked(assertComposeVolumesSafeForRemoval).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(executeLifecycleCommand).mock.invocationCallOrder[0]
    )
    expect(assertComposeVolumesSafeForRemoval).toHaveBeenCalledTimes(3)
    expect(executeLifecycleCommand).toHaveBeenCalledWith("echo cleanup", target)
    expect(vi.mocked(markSetupTornDown).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(executeLifecycleCommand).mock.invocationCallOrder[0]
    )
    expect(compose.composeDown).toHaveBeenCalledWith(
      `${target}/compose.dev.yml`,
      "target-project",
      target,
      true
    )
    expect(markSetupTornDown).toHaveBeenCalledWith(target)
    expect(result).toMatchObject({
      ok: true,
      tornDown: true,
      removed: false,
      endCommand: { ran: true, failed: false },
      composeDown: { ran: true, failed: false, volumesRemoved: true },
    })
    expect(worktree.removeWorktree).not.toHaveBeenCalled()
    expect(withExecDeadline).toHaveBeenCalledWith(110_000, expect.any(Function))
  })

  it("rejects the source worktree before any end command or Docker cleanup", async () => {
    vi.mocked(worktree.getWorktreePath).mockReturnValue("/repo")
    await expect(runWorktreeTeardown("main")).rejects.toMatchObject({
      exitCode: 1,
      result: { ok: false, removed: false },
    })
    expect(executeLifecycleCommand).not.toHaveBeenCalled()
    expect(compose.composeDown).not.toHaveBeenCalled()
  })

  it.each([
    "compose.dev.yml",
    "",
  ])("blocks active setup before cleanup with Compose %s", async (composeFile) => {
    vi.mocked(loadConfig).mockReturnValue({ ...config, docker_compose_file: composeFile })
    vi.mocked(assertSetupNotInProgress).mockImplementation(() => {
      throw new Error("Setup is still running")
    })
    await expect(runWorktreeTeardown("feature/x")).rejects.toThrow("Setup is still running")
    expect(executeLifecycleCommand).not.toHaveBeenCalled()
    expect(compose.composeDown).not.toHaveBeenCalled()
  })

  it("does not run end_command if project ownership cannot be proven", async () => {
    vi.mocked(ownership.assertDockerComposeProjectOwnedByWorktree).mockImplementation(() => {
      throw new Error("foreign Compose project")
    })
    await expect(runWorktreeTeardown("feature/x")).rejects.toMatchObject({
      result: { ok: false, composeDown: { ran: false, failed: true } },
    })
    expect(executeLifecycleCommand).not.toHaveBeenCalled()
    expect(compose.composeDown).not.toHaveBeenCalled()
    expect(markSetupTornDown).not.toHaveBeenCalled()
  })

  it.each([
    "foreign volume",
    "unresolved recovery record",
  ])("blocks end_command on %s even when volume deletion was not requested", async (reason) => {
    vi.mocked(assertComposeVolumesSafeForRemoval).mockImplementation(() => {
      throw new Error(reason)
    })
    await expect(runWorktreeTeardown("feature/x")).rejects.toThrow(reason)
    expect(executeLifecycleCommand).not.toHaveBeenCalled()
    expect(compose.composeDown).not.toHaveBeenCalled()
  })

  it("returns a single partial JSON result when end_command fails and keeps the worktree", async () => {
    vi.mocked(executeLifecycleCommand).mockImplementation(() => {
      throw new Error("script failed")
    })
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    await teardownCommand().parseAsync(["feature/x", "--json", "--remove-volumes"], {
      from: "user",
    })
    expect(output).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(output.mock.calls[0][0]))).toMatchObject({
      ok: false,
      removed: false,
      tornDown: false,
      endCommand: { ran: true, failed: true },
      composeDown: { ran: false, volumesRemoved: false },
    })
    expect(process.exitCode).toBe(1)
    expect(compose.composeDown).not.toHaveBeenCalled()
    expect(worktree.removeWorktree).not.toHaveBeenCalled()
    expect(markSetupTornDown).toHaveBeenCalledWith(target)
  })

  it("reports partial cleanup when Docker fails after a successful end command", async () => {
    vi.mocked(compose.composeDown).mockImplementationOnce(() => {
      throw new Error("daemon unavailable")
    })
    await expect(runWorktreeTeardown("feature/x", { removeVolumes: true })).rejects.toMatchObject({
      exitCode: 5,
      result: {
        ok: false,
        tornDown: false,
        endCommand: { ran: true, failed: false },
        composeDown: { ran: true, failed: true, volumesRemoved: false },
      },
    })
    expect(markSetupTornDown).toHaveBeenCalledWith(target)
  })

  it("revalidates remaining volume ownership after the end command", async () => {
    vi.mocked(executeLifecycleCommand).mockImplementation(() => {
      vi.mocked(assertComposeVolumesSafeForRemoval).mockImplementation(() => {
        throw new Error("volume replaced")
      })
    })
    await expect(runWorktreeTeardown("feature/x", { removeVolumes: true })).rejects.toThrow(
      "volume replaced"
    )
    expect(compose.composeDown).not.toHaveBeenCalled()
    expect(markSetupTornDown).toHaveBeenCalledWith(target)
  })

  it("refuses an identity changed by end_command", async () => {
    vi.mocked(executeLifecycleCommand).mockImplementation(() => {
      vi.mocked(compose.safeResolveComposeProjectName).mockImplementation((_file, cwd) =>
        cwd === "/repo" ? "source-project" : "another-project"
      )
    })
    await expect(runWorktreeTeardown("feature/x")).rejects.toThrow("identity changed")
    expect(compose.composeDown).not.toHaveBeenCalled()
  })

  it("runs only the end command when Compose is not configured", async () => {
    vi.mocked(loadConfig).mockReturnValue({ ...config, docker_compose_file: "" })
    const result = await runWorktreeTeardown("feature/x", { removeVolumes: true })
    expect(result).toMatchObject({ ok: true, tornDown: true, composeDown: null, removed: false })
    expect(executeLifecycleCommand).toHaveBeenCalledWith("echo cleanup", target)
    expect(compose.composeDown).not.toHaveBeenCalled()
    expect(ownership.assertDockerComposeProjectOwnedByWorktree).not.toHaveBeenCalled()
  })

  it("dry-run validates and reports without executing hooks, cleanup, or state writes", async () => {
    const result = await runWorktreeTeardown("feature/x", { dryRun: true, removeVolumes: true })
    expect(result).toMatchObject({ ok: true, dryRun: true, tornDown: false, removed: false })
    expect(assertComposeVolumesSafeForRemoval).toHaveBeenCalled()
    expect(executeLifecycleCommand).not.toHaveBeenCalled()
    expect(compose.composeDown).not.toHaveBeenCalled()
    expect(markSetupTornDown).not.toHaveBeenCalled()
  })

  it("reports missing targets as one JSON error", async () => {
    vi.mocked(worktree.getWorktreePath).mockReturnValue(null)
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    await teardownCommand().parseAsync(["missing", "--json"], { from: "user" })
    expect(output).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(output.mock.calls[0][0]))).toMatchObject({
      branch: "missing",
      path: null,
      ok: false,
      tornDown: false,
      removed: false,
    })
    expect(process.exitCode).toBe(1)
  })
})
