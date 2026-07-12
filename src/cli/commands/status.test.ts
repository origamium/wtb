/**
 * @fileoverview Status コマンドのテスト
 * 新しいディレクトリ構造に対応したテストファイル
 */

import { existsSync } from "node:fs"
import type { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EXIT_CODES } from "../../constants/index.js"
import * as loaderModule from "../../core/config/loader.js"
import * as dockerClientModule from "../../core/docker/client.js"
import * as dockerComposeModule from "../../core/docker/compose.js"
import * as repositoryModule from "../../core/git/repository.js"
import * as worktreeModule from "../../core/git/worktree.js"
import { CLIError } from "../../utils/error.js"
import { statusCommand } from "./status.js"

// Mock dependencies
vi.mock("../../core/config/loader.js")
vi.mock("../../core/git/repository.js")
vi.mock("../../core/git/worktree.js")
vi.mock("../../core/docker/client.js")
vi.mock("../../core/docker/compose.js")
// status.ts reads existsSync from node:fs — mock THAT (partially, keeping every
// other node:fs function real) so env-file detection is actually controllable here.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(),
}))

describe("Status Command (Refactored)", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let command: Command

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    command = statusCommand()

    // Default: Docker IS configured so existing Docker-probe tests keep working.
    vi.mocked(repositoryModule.getGitRoot).mockReturnValue("/project")
    vi.mocked(repositoryModule.getGitRootOrThrow).mockReturnValue("/project")
    vi.mocked(repositoryModule.getMainWorktreeRoot).mockReturnValue("/project")
    vi.mocked(repositoryModule.getRepositoryContext).mockReturnValue({
      currentRoot: "/project",
      mainRoot: "/project",
      commonGitDir: "/project/.git",
    })
    vi.mocked(loaderModule.loadConfig).mockReturnValue({
      base_branch: "main",
      docker_compose_file: "./docker-compose.yml",
      copy_files: [],
      link_files: [],
      env: { file: [], adjust: {} },
    })
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  describe("statusCommand", () => {
    it("should create command with correct configuration", () => {
      expect(command.name()).toBe("status")
      expect(command.description()).toBe("Show status of worktrees and their Docker environments")
    })

    it("should have correct options", () => {
      const options = command.options
      expect(options).toHaveLength(3)

      const allOption = options.find((opt) => opt.flags === "-a, --all")
      expect(allOption?.description).toBe("Show all worktrees, not just current")

      const dockerOnlyOption = options.find((opt) => opt.flags === "--docker-only")
      expect(dockerOnlyOption?.description).toBe("Show only Docker-related information")

      const jsonOption = options.find((opt) => opt.flags === "--json")
      expect(jsonOption).toBeDefined()
    })

    it("should exit with error when not in git repository", async () => {
      vi.mocked(repositoryModule.getRepositoryContext).mockImplementation(() => {
        throw new CLIError("Not in a git repository", EXIT_CODES.NOT_GIT_REPOSITORY)
      })

      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called")
      })

      await expect(async () => {
        await command.parseAsync([], { from: "user" })
      }).rejects.toThrow("process.exit called")

      expect(consoleErrorSpy).toHaveBeenCalledWith("Error: Not in a git repository")
      expect(mockExit).toHaveBeenCalledWith(3) // NOT_GIT_REPOSITORY

      mockExit.mockRestore()
    })

    it("propagates main configuration validation failures as CONFIG_ERROR", async () => {
      vi.mocked(loaderModule.loadConfig).mockImplementation(() => {
        throw new CLIError("unsafe repository-external path", EXIT_CODES.CONFIG_ERROR)
      })
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called")
      })

      await expect(command.parseAsync([], { from: "user" })).rejects.toThrow(
        "process.exit called"
      )

      expect(mockExit).toHaveBeenCalledWith(EXIT_CODES.CONFIG_ERROR)
      mockExit.mockRestore()
    })
  })

  describe("showWorktreeStatus", () => {
    beforeEach(() => {
      vi.mocked(repositoryModule.isGitRepository).mockReturnValue(true)
      vi.mocked(worktreeModule.listWorktrees).mockReturnValue([])
      vi.mocked(repositoryModule.getCurrentBranch).mockReturnValue("main")
      vi.mocked(repositoryModule.getGitRoot).mockReturnValue("/project")
      vi.mocked(dockerClientModule.getRunningContainers).mockReturnValue([])
      vi.mocked(dockerClientModule.getDockerVolumes).mockReturnValue([])
      vi.mocked(existsSync).mockReturnValue(false)
    })

    it("should show message when no worktrees found", async () => {
      vi.mocked(worktreeModule.listWorktrees).mockReturnValue([])

      await command.parseAsync([], { from: "user" })

      expect(consoleSpy).toHaveBeenCalledWith("📁 Git Worktrees Status\n")
      expect(consoleSpy).toHaveBeenCalledWith("No worktrees found")
    })

    it("should display worktree information with --all flag", async () => {
      const mockWorktrees = [
        {
          path: "/project",
          branch: "main",
          head: "abc123",
        },
        {
          path: "/project-feature",
          branch: "feature",
          head: "def456",
        },
      ]

      vi.mocked(worktreeModule.listWorktrees).mockReturnValue(mockWorktrees)
      vi.mocked(repositoryModule.getCurrentBranch).mockReturnValue("main")
      vi.mocked(repositoryModule.getGitRoot).mockReturnValue("/project")

      await command.parseAsync(["--all"], { from: "user" })

      expect(consoleSpy).toHaveBeenCalledWith("→ main (main)")
      expect(consoleSpy).toHaveBeenCalledWith("   📂 /project")
      expect(consoleSpy).toHaveBeenCalledWith("  feature")
      expect(consoleSpy).toHaveBeenCalledWith("   📂 /project-feature")
    })

    it("should show docker-compose file information when present", async () => {
      const mockWorktrees = [
        {
          path: "/project",
          branch: "main",
          head: "abc123",
        },
      ]

      vi.mocked(worktreeModule.listWorktrees).mockReturnValue(mockWorktrees)
      vi.mocked(repositoryModule.getCurrentBranch).mockReturnValue("main")
      vi.mocked(repositoryModule.getGitRoot).mockReturnValue("/project")

      // Mock compose file exists
      vi.mocked(existsSync).mockImplementation((p) =>
        String(p).endsWith("/docker-compose.yml")
      )
      vi.mocked(dockerComposeModule.readComposeFile).mockReturnValue({
        version: "3.8",
        services: {
          web: { image: "nginx" },
          db: { image: "postgres" },
        },
      })

      await command.parseAsync([], { from: "user" })

      expect(consoleSpy).toHaveBeenCalledWith("   🐳 Docker: docker-compose.yml")
      expect(consoleSpy).toHaveBeenCalledWith("   📦 Services: 2")
    })
  })

  describe("showDockerStatus", () => {
    beforeEach(() => {
      vi.mocked(repositoryModule.isGitRepository).mockReturnValue(true)
      vi.mocked(worktreeModule.listWorktrees).mockReturnValue([])
      vi.mocked(dockerClientModule.getRunningContainers).mockReturnValue([])
      vi.mocked(dockerClientModule.getDockerVolumes).mockReturnValue([])
    })

    it("should skip Docker checks and show message when docker_compose_file is not configured", async () => {
      vi.mocked(loaderModule.loadConfig).mockReturnValue({
        base_branch: "main",
        docker_compose_file: "",
        copy_files: [],
        link_files: [],
        env: { file: [], adjust: {} },
      })

      await command.parseAsync([], { from: "user" })

      expect(consoleSpy).toHaveBeenCalledWith("🐳 Docker Environment Status\n")
      expect(consoleSpy).toHaveBeenCalledWith("⚙️  Docker checks skipped (not configured)")
      expect(dockerClientModule.getRunningContainers).not.toHaveBeenCalled()
      expect(dockerClientModule.getDockerVolumes).not.toHaveBeenCalled()
      expect(dockerClientModule.getDockerInfo).not.toHaveBeenCalled()
    })

    it("should show running containers information", async () => {
      const mockContainers = [
        {
          id: "container1",
          name: "app_web_1",
          image: "nginx:alpine",
          status: "Up 5 minutes",
          ports: ["0.0.0.0:3000->80/tcp"],
          volumes: [],
          networks: [],
        },
        {
          id: "container2",
          name: "wtb_api_1",
          image: "node:16",
          status: "Up 1 hour",
          ports: ["0.0.0.0:8080->8080/tcp"],
          volumes: [],
          networks: [],
        },
      ]

      vi.mocked(dockerClientModule.getRunningContainers).mockReturnValue(mockContainers)
      vi.mocked(dockerClientModule.isWtbContainer)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true)

      await command.parseAsync([], { from: "user" })

      expect(consoleSpy).toHaveBeenCalledWith("🐳 Docker Environment Status\n")
      expect(consoleSpy).toHaveBeenCalledWith("📦 Running Containers: 2")
      expect(consoleSpy).toHaveBeenCalledWith("📦 app_web_1")
      expect(consoleSpy).toHaveBeenCalledWith("🌿 wtb_api_1")
    })

    it("should show docker version information", async () => {
      vi.mocked(dockerClientModule.getDockerInfo).mockReturnValue({
        dockerVersion: "Docker version 20.10.17",
        composeVersion: "1.29.2",
        isAvailable: true,
      })

      await command.parseAsync([], { from: "user" })

      expect(consoleSpy).toHaveBeenCalledWith("🔧 Docker Information")
      expect(consoleSpy).toHaveBeenCalledWith("   Docker version 20.10.17")
      expect(consoleSpy).toHaveBeenCalledWith("   Docker Compose: 1.29.2")
    })

    it("should handle docker version command failure", async () => {
      vi.mocked(dockerClientModule.getDockerInfo).mockImplementation(() => {
        throw new Error("Docker not available")
      })

      await command.parseAsync([], { from: "user" })

      expect(consoleSpy).toHaveBeenCalledWith("⚠️  Could not retrieve Docker version information")
    })
  })

  describe("status --json", () => {
    let stdoutSpy: ReturnType<typeof vi.spyOn>
    const parseStdout = () => JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""))

    beforeEach(() => {
      stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
      vi.mocked(repositoryModule.getCurrentBranch).mockReturnValue("main")
      vi.mocked(repositoryModule.getGitRoot).mockReturnValue("/project")
      vi.mocked(worktreeModule.listWorktrees).mockReturnValue([])
      vi.mocked(dockerClientModule.getRunningContainers).mockReturnValue([])
      vi.mocked(dockerClientModule.getDockerVolumes).mockReturnValue([])
      vi.mocked(existsSync).mockReturnValue(false)
    })

    afterEach(() => {
      stdoutSpy.mockRestore()
    })

    it("emits a single valid JSON object on stdout (not console.log)", async () => {
      vi.mocked(dockerClientModule.getDockerInfo).mockReturnValue({
        dockerVersion: "Docker version 25.0",
        composeVersion: "2.24.0",
        isAvailable: true,
      })

      await command.parseAsync(["--json"], { from: "user" })

      const payload = parseStdout()
      expect(payload).toHaveProperty("worktrees")
      expect(payload).toHaveProperty("docker")
      expect(payload.docker.configured).toBe(true)
      expect(payload.docker.available).toBe(true)
      expect(payload.docker.version).toBe("Docker version 25.0")
      // human-readable banners must NOT be printed in JSON mode
      expect(consoleSpy).not.toHaveBeenCalledWith("📁 Git Worktrees Status\n")
    })

    it("includes per-worktree compose + env info filtered to current by default", async () => {
      vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
        { path: "/project", branch: "main", head: "abc" },
        { path: "/project-feature", branch: "feature", head: "def" },
      ])
      vi.mocked(dockerComposeModule.findComposeFile).mockReturnValue("/project/docker-compose.yml")
      vi.mocked(dockerComposeModule.readComposeFile).mockReturnValue({
        services: { web: { image: "nginx" }, db: { image: "postgres" } },
      })
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(dockerClientModule.getDockerInfo).mockReturnValue({
        dockerVersion: "x",
        composeVersion: "y",
        isAvailable: true,
      })

      await command.parseAsync(["--json"], { from: "user" })

      const payload = parseStdout()
      // default (no --all) → only the current branch
      expect(payload.worktrees).toHaveLength(1)
      expect(payload.worktrees[0]).toMatchObject({
        branch: "main",
        isMain: true,
        isCurrent: true,
        compose: { file: "docker-compose.yml", services: 2 },
      })
    })

    it("uses the main config's exact custom Compose path", async () => {
      vi.mocked(loaderModule.loadConfig).mockReturnValue({
        base_branch: "main",
        docker_compose_file: "ops/custom-compose.yml",
        copy_files: [],
        link_files: [],
        env: { file: [], adjust: {} },
      })
      vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
        { path: "/project", branch: "main", head: "abc" },
      ])
      vi.mocked(existsSync).mockImplementation((p) =>
        String(p).endsWith("/ops/custom-compose.yml")
      )
      vi.mocked(dockerComposeModule.readComposeFile).mockReturnValue({ services: {} })

      await command.parseAsync(["--json"], { from: "user" })

      expect(dockerComposeModule.readComposeFile).toHaveBeenCalledWith(
        "/project/ops/custom-compose.yml"
      )
      expect(parseStdout().worktrees[0].compose.file).toBe("custom-compose.yml")
    })

    it("reports docker.available=false (valid JSON) when Docker is unavailable", async () => {
      vi.mocked(dockerClientModule.getDockerInfo).mockImplementation(() => {
        throw new Error("daemon down")
      })

      await command.parseAsync(["--json"], { from: "user" })

      const payload = parseStdout()
      expect(payload.docker.configured).toBe(true)
      expect(payload.docker.available).toBe(false)
      expect(payload.docker.containers).toEqual([])
    })

    it("detects wtb volumes by label even when the name doesn't match the heuristic", async () => {
      // A custom -p path yields a project/volume name without "wtb"/"worktree".
      vi.mocked(dockerClientModule.getDockerInfo).mockReturnValue({
        dockerVersion: "x",
        composeVersion: "y",
        isAvailable: true,
      })
      vi.mocked(dockerClientModule.getDockerVolumes).mockReturnValue([
        { name: "customproj_data", driver: "local", mountpoint: "/v/customproj_data" },
        { name: "unrelated_cache", driver: "local", mountpoint: "/v/unrelated_cache" },
      ])
      // only the wtb-created one carries the label
      vi.mocked(dockerClientModule.getWtbManagedVolumeNames).mockReturnValue(["customproj_data"])

      await command.parseAsync(["--json"], { from: "user" })

      const payload = parseStdout()
      const names = payload.docker.volumes.wtb.map((v: { name: string }) => v.name)
      expect(names).toContain("customproj_data") // matched by label
      expect(names).not.toContain("unrelated_cache") // neither label nor name heuristic
      expect(payload.docker.volumes.total).toBe(2)
      // label-detected entries carry labelled=true
      expect(payload.docker.volumes.wtb).toEqual([
        { name: "customproj_data", driver: "local", labelled: true },
      ])
    })

    it("marks name-heuristic (legacy) volumes with labelled=false", async () => {
      vi.mocked(dockerClientModule.getDockerInfo).mockReturnValue({
        dockerVersion: "x",
        composeVersion: "y",
        isAvailable: true,
      })
      vi.mocked(dockerClientModule.getDockerVolumes).mockReturnValue([
        // pre-label era volume: matches the name heuristic but has no label
        { name: "worktree-old_pg", driver: "local", mountpoint: "/v/worktree-old_pg" },
        { name: "labelled_data", driver: "local", mountpoint: "/v/labelled_data" },
      ])
      vi.mocked(dockerClientModule.getWtbManagedVolumeNames).mockReturnValue(["labelled_data"])

      await command.parseAsync(["--json"], { from: "user" })

      const payload = parseStdout()
      const byName = Object.fromEntries(
        payload.docker.volumes.wtb.map((v: { name: string; labelled: boolean }) => [
          v.name,
          v.labelled,
        ])
      )
      expect(byName["worktree-old_pg"]).toBe(false) // heuristic-only → not authoritative
      expect(byName.labelled_data).toBe(true)
    })

    it("omits worktrees with --docker-only", async () => {
      vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
        { path: "/project", branch: "main", head: "abc" },
      ])
      vi.mocked(dockerClientModule.getDockerInfo).mockReturnValue({
        dockerVersion: "x",
        composeVersion: "y",
        isAvailable: true,
      })

      await command.parseAsync(["--json", "--docker-only"], { from: "user" })

      const payload = parseStdout()
      expect(payload.worktrees).toEqual([])
    })
  })
})

describe("Status Command — human output structure (ordered, end to end render)", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let command: Command

  // Full assembled human output, in order (console.log() with no args → blank line).
  const output = () => consoleSpy.mock.calls.map((c) => (c[0] ?? "") as string).join("\n")
  const assertOrder = (out: string, lines: string[]) => {
    let cursor = -1
    for (const line of lines) {
      const idx = out.indexOf(line, cursor + 1)
      expect(idx, `expected "${line}" to appear after the previous line`).toBeGreaterThan(cursor)
      cursor = idx
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    command = statusCommand()
    vi.mocked(repositoryModule.getGitRoot).mockReturnValue("/project")
    vi.mocked(repositoryModule.getGitRootOrThrow).mockReturnValue("/project")
    vi.mocked(repositoryModule.getCurrentBranch).mockReturnValue("main")
    vi.mocked(repositoryModule.getRepositoryContext).mockReturnValue({
      currentRoot: "/project",
      mainRoot: "/project",
      commonGitDir: "/project/.git",
    })
    vi.mocked(loaderModule.loadConfig).mockReturnValue({
      base_branch: "main",
      docker_compose_file: "./docker-compose.yml",
      copy_files: [],
      link_files: [],
      env: { file: [], adjust: {} },
    })
    vi.mocked(dockerClientModule.getRunningContainers).mockReturnValue([])
    vi.mocked(dockerClientModule.getDockerVolumes).mockReturnValue([])
    vi.mocked(dockerClientModule.getWtbManagedVolumeNames).mockReturnValue([])
    vi.mocked(dockerClientModule.getDockerInfo).mockReturnValue({
      dockerVersion: "Docker version 26.0.0",
      composeVersion: "v2.27.0",
      isAvailable: true,
    })
    vi.mocked(existsSync).mockReturnValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders the documented worktree → docker structure in the right order", async () => {
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/project", branch: "main", head: "abc" },
    ])
    vi.mocked(dockerComposeModule.readComposeFile).mockReturnValue({
      services: { web: { image: "nginx" }, db: { image: "postgres" } },
    })
    // only .env exists in the worktree → the Environment line lists exactly it
    vi.mocked(existsSync).mockImplementation((p) => {
      const value = String(p)
      return value.endsWith("/docker-compose.yml") || value.endsWith("/.env")
    })
    vi.mocked(dockerClientModule.getRunningContainers).mockReturnValue([
      {
        id: "c1",
        name: "project_web_1",
        image: "nginx:alpine",
        status: "Up 3 minutes",
        ports: ["0.0.0.0:3001->80/tcp"],
        volumes: [],
        networks: [],
      },
    ])
    vi.mocked(dockerClientModule.isWtbContainer).mockReturnValue(true)
    vi.mocked(dockerClientModule.getDockerVolumes).mockReturnValue([
      { name: "project_pg_data", driver: "local", mountpoint: "/v/project_pg_data" },
    ])
    vi.mocked(dockerClientModule.getWtbManagedVolumeNames).mockReturnValue(["project_pg_data"])

    await command.parseAsync([], { from: "user" })
    const out = output()

    assertOrder(out, [
      "📁 Git Worktrees Status",
      "→ main (main)",
      "   📂 /project",
      "   🐳 Docker: docker-compose.yml",
      "   📦 Services: 2",
      "   🔧 Environment: .env",
      "🐳 Docker Environment Status",
      "📦 Running Containers: 1",
      "🌿 project_web_1", // wtb container marker
      "   🏷️  Image: nginx:alpine",
      "   🔗 Status: Up 3 minutes",
      "   🔌 Ports: 0.0.0.0:3001->80/tcp",
      "🗂️  Total Volumes: 1",
      "🌿 wtb Volumes: 1",
      "   📁 project_pg_data",
      "      Driver: local",
      "🔧 Docker Information",
      "   Docker version 26.0.0",
      "   Docker Compose: v2.27.0",
    ])
  })

  it("marks only the current worktree with → and only the main worktree with (main)", async () => {
    vi.mocked(repositoryModule.getCurrentBranch).mockReturnValue("feature")
    vi.mocked(repositoryModule.getRepositoryContext).mockReturnValue({
      currentRoot: "/project-feature",
      mainRoot: "/project",
      commonGitDir: "/project/.git",
    })
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/project", branch: "main", head: "abc" }, // main, not current
      { path: "/project-feature", branch: "feature", head: "def" }, // current, not main
    ])
    vi.mocked(dockerComposeModule.findComposeFile).mockReturnValue(null)

    await command.parseAsync(["--all"], { from: "user" })
    const out = output()

    expect(out).toContain("→ feature") // current gets the arrow
    expect(out).not.toContain("→ main") // main is not current → no arrow
    expect(out).toMatch(/ {2}main \(main\)/) // main gets the (main) tag, space marker
    expect(out).not.toContain("feature (main)") // feature is not main → no tag
  })

  it("--docker-only suppresses the worktree section (human mode)", async () => {
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/project", branch: "main", head: "abc" },
    ])

    await command.parseAsync(["--docker-only"], { from: "user" })
    const out = output()

    expect(out).not.toContain("📁 Git Worktrees Status")
    expect(out).not.toContain("→ main")
    expect(out).toContain("🐳 Docker Environment Status")
  })

  it('shows "No compose file" when a worktree has no compose file', async () => {
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/project", branch: "main", head: "abc" },
    ])
    vi.mocked(dockerComposeModule.findComposeFile).mockReturnValue(null)

    await command.parseAsync([], { from: "user" })

    expect(output()).toContain("   🐳 Docker: No compose file")
  })

  it("lists every detected env file on the Environment line, in order", async () => {
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/project", branch: "main", head: "abc" },
    ])
    vi.mocked(dockerComposeModule.findComposeFile).mockReturnValue(null)
    // .env and .env.local present; .env.development / .env.production absent
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p)
      return s.endsWith("/.env") || s.endsWith("/.env.local")
    })

    await command.parseAsync([], { from: "user" })

    expect(output()).toContain("   🔧 Environment: .env, .env.local")
  })
})
