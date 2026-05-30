/**
 * @fileoverview prune コマンドのユニットテスト
 *
 * 孤児判定が安全である (= live worktree の volume を絶対に消さない) ことを最優先で
 * 検証する。temp volume は live worktree のものでも常に候補になること、in-use は
 * skip、--yes 無しは dry-run、--json 形 も検証。resolveComposeProjectName は実関数
 * を使う (partial mock)。
 */

import type { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as clientModule from "../../core/docker/client.js"
import * as composeModule from "../../core/docker/compose.js"
import * as volumeModule from "../../core/docker/volume.js"
import * as loaderModule from "../../core/config/loader.js"
import * as repositoryModule from "../../core/git/repository.js"
import * as worktreeModule from "../../core/git/worktree.js"
import { pruneCommand } from "./prune.js"

vi.mock("../../core/config/loader.js")
vi.mock("../../core/git/repository.js")
vi.mock("../../core/git/worktree.js")
vi.mock("../../core/docker/client.js")
vi.mock("../../core/docker/volume.js")
vi.mock("../../core/docker/compose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/docker/compose.js")>()
  // keep resolveComposeProjectName REAL (it computes the project = basename here),
  // mock only the file readers
  return { ...actual, findComposeFile: vi.fn(() => null), readComposeFile: vi.fn() }
})

describe("prune command", () => {
  let command: Command
  let logSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  const logged = () => logSpy.mock.calls.map((c) => c[0]).join("\n")
  const jsonOut = () => JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""))

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    command = pruneCommand()
    vi.mocked(repositoryModule.getGitRootOrThrow).mockReturnValue("/repo")
    vi.mocked(loaderModule.loadConfig).mockReturnValue({
      base_branch: "main",
      docker_compose_file: "./docker-compose.yml",
      copy_files: [],
      link_files: [],
      env: { file: [], adjust: {} },
      volumes: { exclude: [] },
    })
    // one live worktree whose project (basename) is "worktree-keep"
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/repo", branch: "main", head: "a" },
      { path: "/wt/worktree-keep", branch: "feature/keep", head: "b" },
    ])
    vi.mocked(volumeModule.getContainersUsingVolume).mockReturnValue([])
    vi.mocked(volumeModule.removeVolume).mockReturnValue(undefined)
    vi.mocked(volumeModule.volumeExists).mockReturnValue(false) // removal "succeeds"
  })

  afterEach(() => {
    logSpy.mockRestore()
    stdoutSpy.mockRestore()
  })

  it("flags orphans but NEVER the live worktree's volume (no data loss)", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNames).mockReturnValue([
      "worktree-keep_data", // belongs to the live worktree → must NOT be pruned
      "worktree-gone_data", // no live worktree → orphan
    ])

    await command.parseAsync([], { from: "user" }) // dry-run

    const out = logged()
    expect(out).toContain("worktree-gone_data")
    expect(out).toContain("Dry run")
    expect(out).not.toContain("worktree-keep_data")
    expect(volumeModule.removeVolume).not.toHaveBeenCalled()
  })

  it("does not confuse project-name prefixes (worktree-keep vs worktree-keepx)", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNames).mockReturnValue(["worktree-keepx_data"])
    await command.parseAsync([], { from: "user" })
    // worktree-keepx_data does NOT belong to worktree-keep (the `_` separator guards it)
    expect(logged()).toContain("worktree-keepx_data")
  })

  it("always flags leftover temp volumes even for a live worktree", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNames).mockReturnValue([
      "worktree-keep_data__wtbtmp_abc123", // temp of a LIVE worktree → still a leak
    ])
    await command.parseAsync([], { from: "user" })
    expect(logged()).toContain("leftover temp volume")
  })

  it("--yes removes the orphans and reports the count", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNames).mockReturnValue(["worktree-gone_data"])
    await command.parseAsync(["--yes"], { from: "user" })
    expect(volumeModule.removeVolume).toHaveBeenCalledWith("worktree-gone_data")
    expect(logged()).toContain("Pruned 1 volume")
  })

  it("skips a candidate that is currently in use by a container", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNames).mockReturnValue(["worktree-gone_data"])
    vi.mocked(volumeModule.getContainersUsingVolume).mockReturnValue(["some-container"])
    await command.parseAsync(["--yes"], { from: "user" })
    expect(volumeModule.removeVolume).not.toHaveBeenCalled()
    expect(logged()).toContain("in use by some-container")
  })

  it("reports nothing to do when there are no candidates", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNames).mockReturnValue(["worktree-keep_data"])
    await command.parseAsync([], { from: "user" })
    expect(logged()).toContain("No orphaned or leftover")
    expect(volumeModule.removeVolume).not.toHaveBeenCalled()
  })

  it("--json emits a machine-readable summary", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNames).mockReturnValue([
      "worktree-keep_data",
      "worktree-gone_data",
    ])
    await command.parseAsync(["--json"], { from: "user" })
    const j = jsonOut()
    expect(j.dryRun).toBe(true)
    expect(j.candidates).toHaveLength(1)
    expect(j.candidates[0]).toMatchObject({ name: "worktree-gone_data", reason: "orphan" })
    expect(j.removed).toEqual([])
  })

  it("--json --yes reports removed volumes", async () => {
    vi.mocked(clientModule.getWtbManagedVolumeNames).mockReturnValue(["worktree-gone_data"])
    await command.parseAsync(["--json", "--yes"], { from: "user" })
    const j = jsonOut()
    expect(j.dryRun).toBe(false)
    expect(j.removed).toEqual(["worktree-gone_data"])
  })
})
