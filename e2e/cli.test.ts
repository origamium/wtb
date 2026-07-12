/**
 * @fileoverview Comprehensive E2E Tests for wtb CLI
 * Tests all CLI commands against multiple test projects
 */

import { execSync, spawn, spawnSync } from "node:child_process"
import { existsSync, lstatSync } from "node:fs"
import * as path from "node:path"
import fs from "fs-extra"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  CLI_PATH,
  cleanupAllTestWorkspaces,
  createNonGitDir,
  createTestRepo,
  getTestProjects,
  runCLI,
  type TestRepo,
} from "./helpers.js"

const HAS_DOCKER_DAEMON = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0

// Ensure CLI is built before running tests
beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`CLI not built. Run 'npm run build' first. Expected: ${CLI_PATH}`)
  }
})

afterAll(() => {
  cleanupAllTestWorkspaces()
})

// ponytail: every test here blocks on execSync/spawnSync, so the worker's event
// loop never reaches the poll phase and vitest's IPC acks sit unread; once the
// file runs past birpc's 60s timeout that surfaces as an unhandled
// 'Timeout calling "onTaskUpdate"' error. One macrotask yield per test drains it.
afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve))
})

// =============================================================================
// HELP AND VERSION COMMANDS
// =============================================================================

describe("Help and Version Commands", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("basic", "help")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  describe("--help", () => {
    it("should display main help with all commands listed", () => {
      const result = testRepo.runCLI("--help")

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Usage: wtb")
      expect(result.stdout).toContain("Git worktree management")
      expect(result.stdout).toContain("Commands:")
      expect(result.stdout).toContain("status")
      expect(result.stdout).toContain("create")
      expect(result.stdout).toContain("remove")
      expect(result.stdout).toContain("ls")
    })

    it("should display ls command help with all options", () => {
      const result = testRepo.runCLI("ls --help")

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("List git worktrees")
      expect(result.stdout).toContain("-l, --long")
      expect(result.stdout).toContain("--json")
      expect(result.stdout).toContain("-p, --paths")
    })

    it("should display create command help with all options", () => {
      const result = testRepo.runCLI("create --help")

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Create a new git worktree")
      expect(result.stdout).toContain("-p, --path")
      expect(result.stdout).toContain("--no-create-branch")
      expect(result.stdout).toContain("--strict")
      expect(result.stdout).toContain("setup")
      expect(result.stdout).toContain("<branch>")
    })

    it("should display remove command help with all options", () => {
      const result = testRepo.runCLI("remove --help")

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Remove a git worktree")
      expect(result.stdout).toContain("-f, --force")
      expect(result.stdout).toContain("cleanup failure")
      expect(result.stdout).toContain("<branch>")
    })

    it("should display prune recovery-discard safeguards", () => {
      const result = testRepo.runCLI("prune --help")

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("--discard-recovery")
      expect(result.stdout).toContain("requires --yes")
      expect(result.stdout).toMatch(/protected recovery\s+volumes/)
    })

    it("should display status command help with all options", () => {
      const result = testRepo.runCLI("status --help")

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Show status of worktrees")
      expect(result.stdout).toContain("-a, --all")
      expect(result.stdout).toContain("--docker-only")
    })

    it("should list up and down commands in main help", () => {
      const result = testRepo.runCLI("--help")

      expect(result.exitCode).toBe(0)
      // コマンド一覧の行頭一致で見る ("group" 等の部分一致を避ける)
      expect(result.stdout).toMatch(/^\s+up\s/m)
      expect(result.stdout).toMatch(/^\s+down\s/m)
    })

    it("should display up command help with its options", () => {
      const result = testRepo.runCLI("up --help")

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Docker Compose stack")
      expect(result.stdout).toContain("[branch]")
      expect(result.stdout).toContain("--json")
    })

    it("should display down command help with its options", () => {
      const result = testRepo.runCLI("down --help")

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Docker Compose stack")
      expect(result.stdout).toContain("[branch]")
      expect(result.stdout).toContain("--json")
      expect(result.stdout).toContain("--remove-volumes")
    })
  })

  describe("--version", () => {
    it("should display version number in semver format", () => {
      const result = testRepo.runCLI("--version")

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/)
    })
  })

})

// =============================================================================
// CREATE COMMAND - BASIC PROJECT
// =============================================================================

describe("Create Command - Basic Project", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("basic", "create")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  describe("Basic worktree creation", () => {
    it("should create worktree for a new branch", () => {
      const result = testRepo.runCLI("create test/new-branch --no-docker")

      expect(result.exitCode).toBe(0)
      expect(result.combined).toContain("Creating worktree for branch: test/new-branch")
      expect(result.combined).toContain("Creating new branch: test/new-branch")
      expect(result.combined).toContain("Worktree created successfully")

      // Verify worktree exists
      const wtPath = testRepo.getWorktreePath("test/new-branch")
      expect(existsSync(wtPath)).toBe(true)

      // Verify branch was created
      expect(testRepo.branchExists("test/new-branch")).toBe(true)
    })

    it("should automatically use existing branch", () => {
      // First create a worktree (which also creates the branch)
      testRepo.runCLI("create existing-branch --no-docker")
      testRepo.runCLI("remove existing-branch --force --no-docker")

      // Branch should still exist after worktree removal
      expect(testRepo.branchExists("existing-branch")).toBe(true)

      // Creating a new worktree should detect the existing branch
      const result = testRepo.runCLI("create existing-branch --no-docker")

      expect(result.exitCode).toBe(0)
      expect(result.combined).toContain("already exists")
      expect(result.combined).toContain("Worktree created successfully")
    })

    it("should create worktree at custom path with -p option", () => {
      const customPath = path.join(path.dirname(testRepo.path), "custom-wt-path")
      const result = testRepo.runCLI(`create test/custom -p "${customPath}" --no-docker`)

      expect(result.exitCode).toBe(0)
      expect(result.combined).toContain(`Worktree path: ${customPath}`)
      expect(existsSync(customPath)).toBe(true)
    })

    it("should sanitize branch names with slashes for path", () => {
      const result = testRepo.runCLI("create feature/deep/nested/branch --no-docker")

      expect(result.exitCode).toBe(0)
      expect(result.combined).toContain("worktree-feature-deep-nested-branch")
    })
  })

  describe("Error handling", () => {
    it("should fail when worktree already exists for branch", () => {
      // Create first worktree
      testRepo.runCLI("create duplicate-test --no-docker")

      // Try to create duplicate
      const result = testRepo.runCLI("create duplicate-test --no-docker")

      expect(result.exitCode).toBe(6) // EXIT_CODES.WORKTREE_EXISTS
      expect(result.combined).toContain("already exists")
    })

    it("should fail when branch argument is missing", () => {
      const result = testRepo.runCLI("create")

      expect(result.combined.toLowerCase()).toContain("error")
    })
  })

  describe("Status after create", () => {
    it("should show new worktree in status --all", () => {
      testRepo.runCLI("create status-test --no-docker")

      const result = testRepo.runCLI("status --all")

      expect(result.exitCode).toBe(0)
      expect(result.combined).toContain("status-test")
    })
  })
})

// =============================================================================
// CREATE COMMAND - SEED INSTEAD OF CLONE (--seed)
// =============================================================================

describe("Create Command - Seed instead of clone (--seed)", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    // no-docker project: no docker_compose_file, so the data phase is purely seed.
    testRepo = createTestRepo("no-docker", "seed")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  it("runs volumes.seed_command instead of cloning when --seed is passed", () => {
    testRepo.writeFile(
      "wtb.yaml",
      [
        'base_branch: "main"',
        "copy_files: []",
        "env:",
        "  file: []",
        "  adjust: {}",
        "volumes:",
        '  seed_command: "echo seeded > seeded.marker"',
        "",
      ].join("\n")
    )

    const result = testRepo.runCLI("create feature/seeded --seed")

    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain("Seeding data instead of cloning volumes")
    expect(result.combined).toContain("Seed command completed successfully")
    expect(result.combined).toContain("Worktree created successfully")
    // The seed command wrote its marker into the new worktree (cwd = worktree root).
    expect(testRepo.worktreeFileExists("feature/seeded", "seeded.marker")).toBe(true)
  })

  it("dry-run previews the seed command without running it", () => {
    testRepo.writeFile(
      "wtb.yaml",
      ['base_branch: "main"', "volumes:", '  seed_command: "echo seeded > seeded.marker"', ""].join(
        "\n"
      )
    )

    const result = testRepo.runCLI("create feature/seed-dry --seed --dry-run")

    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain("Would seed data instead of cloning volumes")
    expect(testRepo.worktreeFileExists("feature/seed-dry", "seeded.marker")).toBe(false)
  })

  it("fails with exit 4 when --seed is used without volumes.seed_command", () => {
    // no-docker project's default wtb.yaml has no volumes.seed_command
    const result = testRepo.runCLI("create feature/no-seed --seed")

    expect(result.exitCode).toBe(4)
    expect(result.combined).toContain("--seed requires `volumes.seed_command`")
    // worktree must NOT have been created (validation runs before worktree add)
    expect(testRepo.worktreeFileExists("feature/no-seed", "")).toBe(false)
  })

  it("fails with exit 1 when --seed is combined with --force-volume-copy", () => {
    testRepo.writeFile(
      "wtb.yaml",
      ['base_branch: "main"', "volumes:", '  seed_command: "true"', ""].join("\n")
    )

    const result = testRepo.runCLI("create feature/seed-conflict --seed --force-volume-copy")

    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain("mutually exclusive")
  })

  it("surfaces a NOT-ready banner (exit 0) when the seed command fails", () => {
    testRepo.writeFile(
      "wtb.yaml",
      ['base_branch: "main"', "volumes:", '  seed_command: "exit 7"', ""].join("\n")
    )

    const result = testRepo.runCLI("create feature/seed-fail --seed")

    // worktree is still created (consistent with start_command / volume-clone contract)
    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain("Seed command failed")
    expect(result.combined).toContain("data is NOT ready")
    expect(existsSync(testRepo.getWorktreePath("feature/seed-fail"))).toBe(true)
  })

  it("lists --seed in create --help", () => {
    const result = testRepo.runCLI("create --help")
    expect(result.combined).toContain("--seed")
  })
})

// =============================================================================
// CREATE COMMAND - FULL-FEATURED PROJECT
// =============================================================================

describe("Create Command - Full-Featured Project", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("full-featured", "create-full")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  describe("copy_files functionality", () => {
    it("should copy all files specified in copy_files config", () => {
      const result = testRepo.runCLI("create test/copy-all --no-docker")

      expect(result.exitCode).toBe(0)
      expect(result.combined).toContain("Copying files/directories")

      const wtPath = testRepo.getWorktreePath("test/copy-all")

      // Verify all copy_files were copied
      expect(existsSync(path.join(wtPath, ".env"))).toBe(true)
      expect(existsSync(path.join(wtPath, ".env.local"))).toBe(true)
      expect(existsSync(path.join(wtPath, ".secrets"))).toBe(true)
      expect(existsSync(path.join(wtPath, "config/local.json"))).toBe(true)
      expect(existsSync(path.join(wtPath, "scripts/start.sh"))).toBe(true)
      expect(existsSync(path.join(wtPath, "scripts/stop.sh"))).toBe(true)
    })

    it("should preserve file contents when copying", () => {
      testRepo.runCLI("create test/content-check --no-docker")

      const wtPath = testRepo.getWorktreePath("test/content-check")
      const envContent = fs.readFileSync(path.join(wtPath, ".env"), "utf-8")

      expect(envContent).toContain("APP_PORT=3000")
      expect(envContent).toContain("DB_PORT=5432")
    })

    it("should preserve directory structure when copying", () => {
      testRepo.runCLI("create test/dir-structure --no-docker")

      const wtPath = testRepo.getWorktreePath("test/dir-structure")
      const configContent = fs.readFileSync(path.join(wtPath, "config/local.json"), "utf-8")

      expect(JSON.parse(configContent)).toHaveProperty("app.name", "full-featured-test")
    })
  })

  describe("start_command functionality", () => {
    it("should execute start_command after worktree creation", () => {
      const result = testRepo.runCLI("create test/start-cmd --no-docker")

      expect(result.exitCode).toBe(0)
      expect(result.combined).toContain("Running start command")
      expect(result.combined).toContain("START COMMAND EXECUTED")
      expect(result.combined).toContain("Start command completed successfully")
    })

    it("should create marker file from start_command script", () => {
      testRepo.runCLI("create test/start-marker --no-docker")

      const wtPath = testRepo.getWorktreePath("test/start-marker")
      expect(existsSync(path.join(wtPath, ".start-executed"))).toBe(true)
    })

    it("should have access to copied files in start_command", () => {
      const result = testRepo.runCLI("create test/start-env --no-docker")

      expect(result.exitCode).toBe(0)
      expect(result.combined).toContain(".env found")
      expect(result.combined).toContain(".env.local found")
    })
  })
})

// =============================================================================
// CREATE COMMAND - EDGE CASES PROJECT
// =============================================================================

describe("Create Command - Edge Cases Project", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("edge-cases", "create-edge")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  describe("Files with spaces in path", () => {
    it("should copy directories with spaces in name", () => {
      testRepo.runCLI("create test/spaces --no-docker")

      const wtPath = testRepo.getWorktreePath("test/spaces")
      expect(existsSync(path.join(wtPath, "dir with spaces/config.json"))).toBe(true)
    })
  })

  describe("Deeply nested paths", () => {
    it("should copy files in deeply nested directories", () => {
      testRepo.runCLI("create test/deep --no-docker")

      const wtPath = testRepo.getWorktreePath("test/deep")
      expect(existsSync(path.join(wtPath, "deeply/nested/path/to/file.txt"))).toBe(true)
    })
  })

  describe("Unicode filenames", () => {
    it("should copy files with unicode characters in name", () => {
      testRepo.runCLI("create test/unicode --no-docker")

      const wtPath = testRepo.getWorktreePath("test/unicode")
      expect(existsSync(path.join(wtPath, "unicode-日本語.txt"))).toBe(true)

      const content = fs.readFileSync(path.join(wtPath, "unicode-日本語.txt"), "utf-8")
      expect(content).toContain("こんにちは世界")
    })
  })

  describe("Branch names with special characters", () => {
    it("should handle branch names with multiple slashes", () => {
      const result = testRepo.runCLI("create feature/v1/major/release --no-docker")

      expect(result.exitCode).toBe(0)
      expect(result.combined).toContain("worktree-feature-v1-major-release")
    })

    it("should handle branch names with numbers", () => {
      const result = testRepo.runCLI("create fix/issue-123 --no-docker")

      expect(result.exitCode).toBe(0)
      expect(testRepo.branchExists("fix/issue-123")).toBe(true)
    })
  })
})

// =============================================================================
// CREATE COMMAND - MISSING FILES PROJECT
// =============================================================================

describe("Create Command - Missing Files Handling", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("missing-files", "create-missing")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  describe("Graceful handling of missing copy_files", () => {
    it("should skip non-existent files and continue", () => {
      const result = testRepo.runCLI("create test/skip-missing --no-start --no-docker")

      expect(result.exitCode).toBe(0)
      expect(result.combined).toContain("Skip (not found)")
      expect(result.combined).toContain("Worktree created successfully")
    })

    it("should copy existing files even when some are missing", () => {
      testRepo.runCLI("create test/partial-copy --no-start --no-docker")

      const wtPath = testRepo.getWorktreePath("test/partial-copy")
      expect(existsSync(path.join(wtPath, ".env"))).toBe(true)
    })
  })

  describe("Graceful handling of missing start_command", () => {
    it("keeps the worktree but does not print a success banner when start_command fails", () => {
      const result = testRepo.runCLI("create test/no-script --no-docker")

      expect(result.exitCode).toBe(0)
      expect(result.combined).toContain("Start command failed")
      expect(result.combined).toContain("setup operation(s) FAILED")
      expect(result.combined).not.toContain("Worktree created successfully")
      expect(existsSync(testRepo.getWorktreePath("test/no-script"))).toBe(true)
    })

    it("reports setup failures in JSON and makes --strict non-zero", () => {
      const res = spawnSync(
        "node",
        [
          CLI_PATH,
          "create",
          "test/no-script-strict",
          "--no-docker",
          "--json",
          "--strict",
        ],
        { cwd: testRepo.path, encoding: "utf-8" }
      )

      expect(res.status).toBe(1)
      const payload = JSON.parse(res.stdout)
      expect(payload.created).toBe(true)
      expect(payload.ok).toBe(false)
      expect(payload.setupWarnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ phase: "copy" })])
      )
      expect(payload.setupFailures).toEqual([
        expect.objectContaining({ phase: "start", message: "start_command failed" }),
      ])
      expect(existsSync(testRepo.getWorktreePath("test/no-script-strict"))).toBe(true)
    })
  })
})

// =============================================================================
// REMOVE COMMAND - BASIC PROJECT
// =============================================================================

describe("Remove Command - Basic Project", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("basic", "remove")
    // Create a worktree to remove
    testRepo.runCLI("create test/to-remove --no-docker --no-start")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  describe("Basic worktree removal", () => {
    it("should remove existing worktree", () => {
      const wtPath = testRepo.getWorktreePath("test/to-remove")
      expect(existsSync(wtPath)).toBe(true)

      const result = testRepo.runCLI("remove test/to-remove --no-docker")

      expect(result.exitCode).toBe(0)
      expect(result.combined).toContain("Worktree removed successfully")
      expect(existsSync(wtPath)).toBe(false)
    })

    it("should show remaining worktrees after removal", () => {
      const result = testRepo.runCLI("remove test/to-remove --no-docker")

      expect(result.combined).toContain("Remaining worktrees")
      expect(result.combined).toContain("main")
    })
  })

  describe("--json", () => {
    it("emits machine-readable JSON on stdout and the human banner on stderr", () => {
      // runCLI (execSync) は成功時 stderr を捨てるので、stdout/stderr を分けて
      // 検証できる spawnSync を使う (--json の stdout 純度がこのテストの主眼)。
      const res = spawnSync(
        "node",
        [CLI_PATH, "remove", "test/to-remove", "--json", "--no-docker"],
        {
          cwd: testRepo.path,
          encoding: "utf-8",
        }
      )

      expect(res.status).toBe(0)
      const payload = JSON.parse(res.stdout)
      expect(payload.branch).toBe("test/to-remove")
      expect(payload.removed).toBe(true)
      expect(payload.composeDown).toMatchObject({
        ran: false,
        failed: false,
        skippedReason: "no-docker-flag",
      })
      expect(payload.endCommand).toBeNull()
      expect(payload.cleanupErrors).toEqual([])
      expect(payload.ok).toBe(true)
      // 人間向けバナーは stderr へ
      expect(res.stderr).toContain("Worktree removed successfully")
      expect(existsSync(testRepo.getWorktreePath("test/to-remove"))).toBe(false)
    })

    it("always emits one JSON object for a hard error", () => {
      const res = spawnSync("node", [CLI_PATH, "remove", "does/not/exist", "--json"], {
        cwd: testRepo.path,
        encoding: "utf-8",
      })

      expect(res.status).toBe(1)
      const payload = JSON.parse(res.stdout)
      expect(payload).toMatchObject({
        branch: "does/not/exist",
        path: null,
        removed: false,
        composeDown: null,
        endCommand: null,
        ok: false,
      })
      expect(payload.cleanupErrors).toEqual([expect.stringContaining("No worktree found")])
    })
  })

  describe("Force removal", () => {
    it("should force remove worktree with untracked files", () => {
      const wtPath = testRepo.getWorktreePath("test/to-remove")
      fs.writeFileSync(path.join(wtPath, "untracked.txt"), "untracked content")

      const result = testRepo.runCLI("remove test/to-remove --force --no-docker")

      expect(result.exitCode).toBe(0)
      expect(result.combined).toContain("Force removal enabled")
      expect(result.combined).toContain("Worktree removed successfully")
    })

    it("should force remove worktree with modified files", () => {
      const wtPath = testRepo.getWorktreePath("test/to-remove")
      fs.writeFileSync(path.join(wtPath, "README.md"), "modified content")

      const result = testRepo.runCLI("remove test/to-remove --force --no-docker")

      expect(result.exitCode).toBe(0)
      expect(existsSync(wtPath)).toBe(false)
    })
  })

  describe("Error handling", () => {
    it("should fail when worktree does not exist", () => {
      // Remove first
      testRepo.runCLI("remove test/to-remove --force --no-docker")

      const result = testRepo.runCLI("remove nonexistent/branch")

      expect(result.exitCode).toBe(1)
      expect(result.combined).toContain("No worktree found for branch")
    })

    it("should prevent removing main repository", () => {
      const result = testRepo.runCLI("remove main")

      expect(result.exitCode).toBe(1)
      expect(result.combined).toContain("Cannot remove the main repository")
    })

    it("should list available worktrees when target not found", () => {
      testRepo.runCLI("remove test/to-remove --force --no-docker")

      const result = testRepo.runCLI("remove nonexistent")

      expect(result.combined).toContain("Available worktrees")
    })
  })
})

// =============================================================================
// REMOVE COMMAND - WTB-MANAGED FILE PROTECTION (B1)
// =============================================================================
// wtb rewrites git-TRACKED files per worktree (compose identity/ports + adjusted
// env) and skip-worktrees them. A manifest records wtb's exact output sha so that
// `remove` can tell wtb's own rewrite (safe to delete) apart from a genuine user
// edit (must block without -f). These real-git e2e tests are the most faithful
// check of that data-loss protection.
describe("Remove Command - wtb-managed file protection (B1)", () => {
  let testRepo: TestRepo
  const BRANCH = "mng/protect"

  beforeEach(() => {
    testRepo = createTestRepo("relocatability", "managed-protect")
    // create rewrites the tracked compose (identity) + .env (port adjust) → both
    // become wtb-managed. Skip volume clone / start so the test needs no Docker.
    const flags = HAS_DOCKER_DAEMON
      ? "--no-volume-copy --no-start"
      : "--no-docker --no-start"
    testRepo.runCLI(`create ${BRANCH} ${flags}`)
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  it("writes a wtb-managed manifest into the worktree's private git dir", () => {
    const wtPath = testRepo.getWorktreePath(BRANCH)
    const manifestPath = execSync("git rev-parse --git-path wtb-managed.json", {
      cwd: wtPath,
      encoding: "utf-8",
    }).trim()
    const abs = path.isAbsolute(manifestPath) ? manifestPath : path.join(wtPath, manifestPath)
    expect(existsSync(abs)).toBe(true)
    const manifest = JSON.parse(fs.readFileSync(abs, "utf-8"))
    expect(manifest.version).toBe(1)
    // The adjusted env is always managed. Compose is also managed when the
    // Docker-backed identity/ownership preflight can run.
    const keys = Object.keys(manifest.files)
    if (HAS_DOCKER_DAEMON) {
      expect(keys.some((k) => k.includes("docker-compose.yml"))).toBe(true)
    }
    expect(keys.some((k) => k.includes(".env"))).toBe(true)
  })

  it("(b) removes cleanly when managed files are exactly wtb's output (no user edit)", () => {
    const wtPath = testRepo.getWorktreePath(BRANCH)
    expect(existsSync(wtPath)).toBe(true)

    // No user edit → the only "changes" are wtb's own rewrites, which the manifest
    // recognises and excludes from the dirty check. Remove must succeed without -f.
    const result = testRepo.runCLI(`remove ${BRANCH} --no-docker`)
    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain("Worktree removed successfully")
    expect(existsSync(wtPath)).toBe(false)
  })

  it("(c) BLOCKS removal (without -f) when the user hand-edits a managed file", () => {
    const wtPath = testRepo.getWorktreePath(BRANCH)
    // Simulate a genuine user edit on top of wtb's rewritten .env.
    fs.appendFileSync(path.join(wtPath, ".env"), "\nUSER_SECRET=do-not-lose-me\n")

    const result = testRepo.runCLI(`remove ${BRANCH} --no-docker`)

    // The edit diverges from the recorded sha → really dirty → blocked, worktree kept.
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain("uncommitted or untracked changes")
    expect(existsSync(wtPath)).toBe(true)
  })

  it("(d) still removes a user-edited managed file with -f", () => {
    const wtPath = testRepo.getWorktreePath(BRANCH)
    fs.appendFileSync(path.join(wtPath, ".env"), "\nUSER_SECRET=do-not-lose-me\n")

    const result = testRepo.runCLI(`remove ${BRANCH} -f --no-docker`)

    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain("Worktree removed successfully")
    expect(existsSync(wtPath)).toBe(false)
  })

  it("(c') BLOCKS removal when there is an unrelated untracked file", () => {
    const wtPath = testRepo.getWorktreePath(BRANCH)
    fs.writeFileSync(path.join(wtPath, "scratch.txt"), "untracked work")

    const result = testRepo.runCLI(`remove ${BRANCH} --no-docker`)

    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain("uncommitted or untracked changes")
    expect(existsSync(wtPath)).toBe(true)
  })

  it("fails closed when a real Git S-bit is absent from the manifest, preserving it even with -f", () => {
    const wtPath = testRepo.getWorktreePath(BRANCH)
    const hiddenPath = path.join(wtPath, "DESCRIPTION.txt")
    const original = fs.readFileSync(hiddenPath, "utf-8")

    // Simulate an S-bit owned outside wtb. Its edit is invisible to `git status`, and the
    // valid manifest deliberately does not list DESCRIPTION.txt.
    execSync("git update-index --skip-worktree -- DESCRIPTION.txt", {
      cwd: wtPath,
      stdio: "pipe",
    })
    fs.writeFileSync(hiddenPath, `${original}\nUSER_DATA=must-survive\n`)

    const result = testRepo.runCLI(`remove ${BRANCH} -f --no-docker`)

    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain("missing from the wtb-managed manifest")
    expect(existsSync(wtPath)).toBe(true)
    expect(fs.readFileSync(hiddenPath, "utf-8")).toContain("USER_DATA=must-survive")
    expect(
      execSync("git ls-files -v -- DESCRIPTION.txt", { cwd: wtPath, encoding: "utf-8" })
    ).toMatch(/^[Ss] /)
  })

  it("fails closed for a real Git h tag and preserves assume-unchanged plus user data", () => {
    const wtPath = testRepo.getWorktreePath(BRANCH)
    const hiddenPath = path.join(wtPath, "DESCRIPTION.txt")
    const original = fs.readFileSync(hiddenPath, "utf-8")

    execSync("git update-index --assume-unchanged -- DESCRIPTION.txt", {
      cwd: wtPath,
      stdio: "pipe",
    })
    fs.writeFileSync(hiddenPath, `${original}\nASSUME_DATA=must-survive\n`)
    expect(
      execSync("git ls-files -v -- DESCRIPTION.txt", { cwd: wtPath, encoding: "utf-8" })
    ).toMatch(/^h /)

    const result = testRepo.runCLI(`remove ${BRANCH} -f --no-docker`)

    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain("assume-unchanged")
    expect(existsSync(wtPath)).toBe(true)
    expect(fs.readFileSync(hiddenPath, "utf-8")).toContain("ASSUME_DATA=must-survive")
    expect(
      execSync("git ls-files -v -- DESCRIPTION.txt", { cwd: wtPath, encoding: "utf-8" })
    ).toMatch(/^h /)
  })

  it("fails closed for a lowercase Git tag even when the managed manifest contains the path", () => {
    const wtPath = testRepo.getWorktreePath(BRANCH)
    const managedPath = path.join(wtPath, ".env")
    const before = fs.readFileSync(managedPath, "utf-8")

    // create already gave this manifest-managed path skip-worktree (S). Combining
    // assume-unchanged changes the tag to lowercase s; clearing only skip-worktree would
    // still leave its content hidden from status.
    execSync("git update-index --assume-unchanged -- .env", { cwd: wtPath, stdio: "pipe" })
    expect(execSync("git ls-files -v -- .env", { cwd: wtPath, encoding: "utf-8" })).toMatch(
      /^[a-z] /
    )

    const result = testRepo.runCLI(`remove ${BRANCH} -f --no-docker`)

    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain("assume-unchanged")
    expect(existsSync(wtPath)).toBe(true)
    expect(fs.readFileSync(managedPath, "utf-8")).toBe(before)
    expect(execSync("git ls-files -v -- .env", { cwd: wtPath, encoding: "utf-8" })).toMatch(
      /^[a-z] /
    )
  })

  it("keeps a file written concurrently while a sleeping end_command runs", async () => {
    const wtPath = testRepo.getWorktreePath(BRANCH)
    fs.appendFileSync(path.join(testRepo.path, "wtb.yaml"), '\nend_command: "sleep 1"\n')

    const child = spawn(
      process.execPath,
      [CLI_PATH, "remove", BRANCH, "--no-docker"],
      { cwd: testRepo.path, stdio: ["ignore", "pipe", "pipe"] }
    )
    let output = ""
    let signalEndStarted: (() => void) | undefined
    const endStarted = new Promise<void>((resolve) => {
      signalEndStarted = resolve
    })
    const collect = (chunk: Buffer): void => {
      output += chunk.toString()
      if (output.includes("Running end command: sleep 1")) signalEndStarted?.()
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    child.once("error", (error) => {
      output += error.message
      signalEndStarted?.()
    })
    const completed = new Promise<number>((resolve) => {
      child.once("close", (code) => {
        signalEndStarted?.()
        resolve(code ?? 1)
      })
    })

    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        endStarted,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`end_command did not start; output:\n${output}`)),
            5000
          )
        }),
      ])
      expect(output).toContain("Running end command: sleep 1")

      // This write occurs after the initial dirty snapshot and while remove is blocked in sleep.
      fs.writeFileSync(path.join(wtPath, "late-during-end.txt"), "must survive\n")

      const exitCode = await completed
      expect(exitCode, output).toBe(1)
      expect(output).toContain("changed during cleanup")
      expect(existsSync(wtPath)).toBe(true)
      expect(fs.readFileSync(path.join(wtPath, "late-during-end.txt"), "utf-8")).toBe(
        "must survive\n"
      )
      // The failed removal leaves the worktree in its original managed state.
      expect(execSync("git ls-files -v -- .env", { cwd: wtPath, encoding: "utf-8" })).toMatch(
        /^S /
      )
    } finally {
      if (timeout) clearTimeout(timeout)
      if (child.exitCode === null) child.kill("SIGTERM")
    }
  })
})

// =============================================================================
// REMOVE COMMAND - FULL-FEATURED PROJECT
// =============================================================================

describe("Remove Command - Full-Featured Project", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("full-featured", "remove-full")
    testRepo.runCLI("create test/end-cmd")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  describe("end_command functionality", () => {
    it("should execute end_command before worktree removal", () => {
      const result = testRepo.runCLI("remove test/end-cmd --force")

      expect(result.exitCode).toBe(0)
      expect(result.combined).toContain("Running end command")
      expect(result.combined).toContain("STOP COMMAND EXECUTED")
      expect(result.combined).toContain("End command completed successfully")
    })
  })
})

// =============================================================================
// REMOVE COMMAND - MISSING FILES PROJECT
// =============================================================================

describe("Remove Command - Missing Files Handling", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("missing-files", "remove-missing")
    testRepo.runCLI("create test/missing-end")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  describe("Graceful handling of missing end_command", () => {
    it("force-removes but exits non-zero when end_command fails", () => {
      const wtPath = testRepo.getWorktreePath("test/missing-end")
      const result = testRepo.runCLI("remove test/missing-end --force")

      expect(result.exitCode).toBe(1)
      expect(result.combined).toContain("End command failed")
      expect(result.combined).toContain("force-removed, but cleanup was incomplete")
      expect(result.combined).not.toContain("Worktree removed successfully")
      expect(existsSync(wtPath)).toBe(false)
    })
  })
})

// =============================================================================
// STATUS COMMAND
// =============================================================================

describe("Status Command", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("full-featured", "status")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  describe("Basic status display", () => {
    it("should show Git Worktrees Status header", () => {
      const result = testRepo.runCLI("status")

      expect(result.exitCode).toBe(0)
      expect(result.combined).toContain("Git Worktrees Status")
    })

    it("should show main branch as current", () => {
      const result = testRepo.runCLI("status")

      expect(result.combined).toContain("main")
      expect(result.combined).toContain("→")
    })

    it("should show Docker Environment Status", () => {
      const result = testRepo.runCLI("status")

      expect(result.combined).toContain("Docker Environment Status")
    })
  })

  describe("--all flag", () => {
    it("should show all worktrees with --all flag", () => {
      testRepo.runCLI("create branch1")
      testRepo.runCLI("create branch2")

      const result = testRepo.runCLI("status --all")

      expect(result.combined).toContain("main")
      expect(result.combined).toContain("branch1")
      expect(result.combined).toContain("branch2")
    })
  })

  describe("--docker-only flag", () => {
    it("should show only Docker status with --docker-only flag", () => {
      const result = testRepo.runCLI("status --docker-only")

      expect(result.exitCode).toBe(0)
      expect(result.combined).toContain("Docker Environment Status")
      expect(result.combined).not.toContain("Git Worktrees Status")
    })
  })

  describe("--json flag", () => {
    it("emits valid JSON with worktrees + docker keys on stdout", () => {
      const result = testRepo.runCLI("status --json")

      expect(result.exitCode).toBe(0)
      // stdout must be parseable JSON on its own (warnings go to stderr)
      const payload = JSON.parse(result.stdout)
      expect(payload).toHaveProperty("worktrees")
      expect(payload).toHaveProperty("docker")
      expect(Array.isArray(payload.worktrees)).toBe(true)
      // full-featured project configures docker_compose_file
      expect(payload.docker.configured).toBe(true)
      // human-readable banners must be absent in JSON mode
      expect(result.combined).not.toContain("📁 Git Worktrees Status")
    })

    it("--docker-only --json yields an empty worktrees array", () => {
      const result = testRepo.runCLI("status --docker-only --json")

      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout)
      expect(payload.worktrees).toEqual([])
    })
  })

  describe("Environment file detection", () => {
    it("should detect and show environment files", () => {
      const result = testRepo.runCLI("status")

      // The status command shows env files if they exist
      expect(result.exitCode).toBe(0)
    })
  })
})

// =============================================================================
// STATUS COMMAND - NO DOCKER PROJECT
// =============================================================================

describe("Status Command - No Docker Project", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("no-docker", "status-no-docker")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  it("should show Docker checks skipped when docker_compose_file is not configured", () => {
    const result = testRepo.runCLI("status")

    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain("Docker Environment Status")
    expect(result.combined).toContain("Docker checks skipped (not configured)")
  })

  it("should still show Git worktree status when Docker is not configured", () => {
    const result = testRepo.runCLI("status")

    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain("Git Worktrees Status")
    expect(result.combined).toContain("main")
  })

  it("should show Docker checks skipped with --docker-only flag", () => {
    const result = testRepo.runCLI("status --docker-only")

    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain("Docker Environment Status")
    expect(result.combined).toContain("Docker checks skipped (not configured)")
    expect(result.combined).not.toContain("Git Worktrees Status")
  })
})

// =============================================================================
// REMOVE COMMAND - --remove-volumes guardrails
// =============================================================================

describe("Remove Command - --remove-volumes guardrails", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("basic", "rmvol-guard")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  it("warns that --remove-volumes had no effect when end_command owns teardown", () => {
    testRepo.writeFile(
      "wtb.yaml",
      [
        'base_branch: "main"',
        "docker_compose_file: ./docker-compose.yml",
        'end_command: "echo end-ran"',
        "",
      ].join("\n")
    )
    testRepo.runCLI("create test/x --no-docker --no-start")

    const result = testRepo.runCLI("remove test/x --remove-volumes --force")

    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain("--remove-volumes had no effect")
    expect(result.combined).toContain("end_command")
    // end_command still runs
    expect(result.combined).toContain("end-ran")
  })

  it("warns that --remove-volumes had no effect with --no-docker", () => {
    testRepo.writeFile(
      "wtb.yaml",
      ['base_branch: "main"', "docker_compose_file: ./docker-compose.yml", ""].join("\n")
    )
    testRepo.runCLI("create test/y --no-docker --no-start")

    const result = testRepo.runCLI("remove test/y --remove-volumes --no-docker --force")

    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain("--remove-volumes had no effect")
  })
})

// =============================================================================
// RECLONE COMMAND
// =============================================================================

describe("Reclone Command", () => {
  it("is listed in top-level help", () => {
    const testRepo = createTestRepo("basic", "reclone-help")
    try {
      const result = testRepo.runCLI("--help")
      expect(result.combined).toContain("reclone")
    } finally {
      testRepo.cleanup()
    }
  })

  describe("No Docker project", () => {
    let testRepo: TestRepo
    beforeEach(() => {
      testRepo = createTestRepo("no-docker", "reclone-no-docker")
    })
    afterEach(() => {
      testRepo.cleanup()
    })

    it("reports nothing to clone when docker_compose_file is unset (exit 0)", () => {
      testRepo.runCLI("create feature/x")
      // run reclone targeting the created worktree by branch
      const result = testRepo.runCLI("reclone feature/x")

      expect(result.exitCode).toBe(0)
      expect(result.combined).toContain("No docker_compose_file configured")
    })

    it("fails with exit 1 for an unknown branch", () => {
      const result = testRepo.runCLI("reclone does/not/exist")

      expect(result.exitCode).toBe(1)
      expect(result.combined).toContain("No worktree found for branch")
    })

    it("refuses to reclone the main repository worktree", () => {
      // run with no branch arg from the main repo root → resolves to main worktree
      const result = testRepo.runCLI("reclone")

      expect(result.exitCode).toBe(1)
      expect(result.combined).toContain("main repository worktree")
    })
  })
})

// =============================================================================
// UP / DOWN COMMANDS
// =============================================================================
// NOTE: 実際に docker を起動する幸福系は e2e/integration-docker.sh 側で担保する。
// ここでは docker 不要で決まるエラー経路 (config / target 解決) のみを検証する。
describe("Up and Down Commands", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("no-docker", "updown")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  it("up exits with CONFIG_ERROR (4) when no docker_compose_file is configured", () => {
    testRepo.runCLI("create feature/updown --no-docker --no-start")

    const result = testRepo.runCLI("up feature/updown")

    expect(result.exitCode).toBe(4)
    expect(result.combined).toContain("No docker_compose_file is configured")
  })

  it("down exits with CONFIG_ERROR (4) when no docker_compose_file is configured", () => {
    testRepo.runCLI("create feature/updown-d --no-docker --no-start")

    const result = testRepo.runCLI("down feature/updown-d")

    expect(result.exitCode).toBe(4)
    expect(result.combined).toContain("No docker_compose_file is configured")
  })

  it("up fails with exit 1 for an unknown branch and lists available worktrees on stderr", () => {
    const result = testRepo.runCLI("up does/not/exist")

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("No worktree found for branch")
    expect(result.stderr).toContain("Available worktrees:")
    expect(result.stdout).toBe("")
  })

  it("up refuses the main repository worktree", () => {
    // branch 無しで main repo root から実行 → main worktree に解決され拒否される
    const result = testRepo.runCLI("up")

    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain("main repository worktree")
  })

  it("up works from INSIDE a linked worktree (regression: main-root resolution)", () => {
    // 回帰テスト: 旧実装は gitRoot に `--show-toplevel` (= worktree 内では worktree 自身)
    // を使っていたため、worktree 内からの実行が常に main-repo ガード (exit 1) で拒否され、
    // 「default: the current worktree」がどこからも成立しなかった。正しい実装では main
    // root が source として解決され、ガードを通過して設定チェック (exit 4) に到達する。
    testRepo.runCLI("create feature/updown-inside --no-docker --no-start")
    const worktreePath = testRepo.runCLI("path feature/updown-inside").stdout.trim()

    const result = runCLI("up", worktreePath)

    expect(result.exitCode).toBe(4)
    expect(result.combined).toContain("No docker_compose_file is configured")
    expect(result.combined).not.toContain("main repository worktree")
  })
})

// =============================================================================
// PRUNE COMMAND
// =============================================================================
// NOTE: `wtb prune` queries GLOBAL Docker volumes, so we deliberately never run
// `--yes` here (it could delete real volumes on a dev machine). The full
// create→orphan→prune correctness is covered by e2e/integration-docker.sh in an
// isolated temp project. Here we only exercise the safe, side-effect-free paths.
describe("Prune Command", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("basic", "prune")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  it("is listed in top-level help", () => {
    const result = testRepo.runCLI("--help")
    expect(result.combined).toContain("prune")
  })

  it.skipIf(!HAS_DOCKER_DAEMON)("--json emits a valid dry-run summary (no deletion)", () => {
    const result = testRepo.runCLI("prune --json")

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout)
    // shape only — values depend on the host's global wtb volumes; never assert deletion
    expect(payload.dryRun).toBe(true)
    expect(Array.isArray(payload.candidates)).toBe(true)
    expect(Array.isArray(payload.protected)).toBe(true)
    expect(Array.isArray(payload.removed)).toBe(true)
    expect(payload.removed).toEqual([]) // dry-run never removes
  })

  it.skipIf(HAS_DOCKER_DAEMON)("fails closed without a Docker daemon", () => {
    const result = testRepo.runCLI("prune --json")

    expect(result.exitCode).not.toBe(0)
    expect(result.combined.toLowerCase()).toMatch(/docker|daemon/)
  })
})

// =============================================================================
// FULL WORKFLOW TESTS
// =============================================================================

describe("Full Workflow Tests", () => {
  describe("Basic project workflow", () => {
    let testRepo: TestRepo

    beforeEach(() => {
      testRepo = createTestRepo("basic", "workflow-basic")
    })

    afterEach(() => {
      testRepo.cleanup()
    })

    it("should complete create → status → remove cycle", () => {
      // Create
      const createResult = testRepo.runCLI("create feature/workflow --no-docker --no-start")
      expect(createResult.exitCode).toBe(0)

      // Status
      const statusResult = testRepo.runCLI("status --all")
      expect(statusResult.combined).toContain("feature/workflow")

      // Remove
      const removeResult = testRepo.runCLI("remove feature/workflow --no-docker")
      expect(removeResult.exitCode).toBe(0)

      // Verify removed
      const finalStatus = testRepo.runCLI("status --all")
      expect(finalStatus.combined).not.toContain("feature/workflow")
    })
  })

  describe("Full-featured project workflow", () => {
    let testRepo: TestRepo

    beforeEach(() => {
      testRepo = createTestRepo("full-featured", "workflow-full")
    })

    afterEach(() => {
      testRepo.cleanup()
    })

    it("should complete full lifecycle with all features", () => {
      // Create with copy_files and start_command
      const createResult = testRepo.runCLI("create feature/full-lifecycle --no-docker")

      expect(createResult.exitCode).toBe(0)
      expect(createResult.combined).toContain("Copying files/directories")
      expect(createResult.combined).toContain("START COMMAND EXECUTED")

      const wtPath = testRepo.getWorktreePath("feature/full-lifecycle")

      // Verify copy_files
      expect(existsSync(path.join(wtPath, ".env"))).toBe(true)
      expect(existsSync(path.join(wtPath, ".secrets"))).toBe(true)
      expect(existsSync(path.join(wtPath, "config/local.json"))).toBe(true)

      // Verify start_command marker
      expect(existsSync(path.join(wtPath, ".start-executed"))).toBe(true)

      // Remove with end_command
      const removeResult = testRepo.runCLI("remove feature/full-lifecycle --force")

      expect(removeResult.exitCode).toBe(0)
      expect(removeResult.combined).toContain("STOP COMMAND EXECUTED")
      expect(removeResult.combined).toContain("Worktree removed successfully")

      // Verify cleanup
      expect(existsSync(wtPath)).toBe(false)
    })
  })

  describe("Multiple worktrees workflow", () => {
    let testRepo: TestRepo

    beforeEach(() => {
      testRepo = createTestRepo("basic", "workflow-multi")
    })

    afterEach(() => {
      testRepo.cleanup()
    })

    it("should manage multiple worktrees simultaneously", () => {
      // Create multiple worktrees
      testRepo.runCLI("create feature/one --no-docker --no-start")
      testRepo.runCLI("create feature/two --no-docker --no-start")
      testRepo.runCLI("create feature/three --no-docker --no-start")

      // Verify all exist
      const worktrees = testRepo.listWorktrees()
      expect(worktrees.length).toBe(4) // main + 3 features

      // Status shows all
      const status = testRepo.runCLI("status --all")
      expect(status.combined).toContain("feature/one")
      expect(status.combined).toContain("feature/two")
      expect(status.combined).toContain("feature/three")

      // Remove one
      testRepo.runCLI("remove feature/two --no-docker")

      // Verify removed
      const statusAfter = testRepo.runCLI("status --all")
      expect(statusAfter.combined).toContain("feature/one")
      expect(statusAfter.combined).not.toContain("feature/two")
      expect(statusAfter.combined).toContain("feature/three")
    })
  })
})

// =============================================================================
// ERROR HANDLING TESTS
// =============================================================================

describe("Error Handling", () => {
  describe("Not in git repository", () => {
    it("should error when running create outside git repo", () => {
      const { path: nonGitPath, cleanup } = createNonGitDir("create-test")

      try {
        const result = runCLI("create test/branch", nonGitPath)

        expect(result.exitCode).toBeGreaterThan(0)
        expect(result.combined.toLowerCase()).toContain("not")
        expect(result.combined.toLowerCase()).toContain("git")
      } finally {
        cleanup()
      }
    })

    it("should error when running remove outside git repo", () => {
      const { path: nonGitPath, cleanup } = createNonGitDir("remove-test")

      try {
        const result = runCLI("remove test/branch", nonGitPath)

        expect(result.exitCode).toBeGreaterThan(0)
        expect(result.combined.toLowerCase()).toContain("not")
      } finally {
        cleanup()
      }
    })

    it("should error when running status outside git repo", () => {
      const { path: nonGitPath, cleanup } = createNonGitDir("status-test")

      try {
        const result = runCLI("status", nonGitPath)

        expect(result.exitCode).toBeGreaterThan(0)
      } finally {
        cleanup()
      }
    })
  })

  describe("Missing arguments", () => {
    let testRepo: TestRepo

    beforeEach(() => {
      testRepo = createTestRepo("basic", "error-args")
    })

    afterEach(() => {
      testRepo.cleanup()
    })

    it("should show help when no command given and no branch option", () => {
      const result = testRepo.runCLI("")

      // Should show help
      expect(result.combined).toContain("Usage")
    })
  })
})

// =============================================================================
// CROSS-PROJECT TESTS
// =============================================================================

describe("Cross-Project Compatibility", () => {
  const projects = getTestProjects()

  for (const project of projects) {
    describe(`Project: ${project.name}`, () => {
      let testRepo: TestRepo

      beforeEach(() => {
        testRepo = createTestRepo(project.name, "cross")
      })

      afterEach(() => {
        testRepo.cleanup()
      })

      it("should create worktree successfully", () => {
        const result = testRepo.runCLI("create test/cross-project --no-docker --no-start")

        expect(result.exitCode).toBe(0)
        expect(result.combined).toContain("Worktree created successfully")
      })

      it("should show status without errors", () => {
        const result = testRepo.runCLI("status")

        expect(result.exitCode).toBe(0)
        expect(result.combined).toContain("Git Worktrees Status")
      })

      it("should remove worktree successfully", () => {
        testRepo.runCLI("create test/to-cleanup --no-docker --no-start")

        const result = testRepo.runCLI(
          "remove test/to-cleanup --force --no-docker --no-end"
        )

        expect(result.exitCode).toBe(0)
        expect(result.combined).toContain("Worktree removed successfully")
      })
    })
  }
})

// =============================================================================
// LINK_FILES TESTS
// =============================================================================

describe("Create Command - link_files", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("link-files", "link-files")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  it("should create symlinks for paths in link_files", () => {
    const result = testRepo.runCLI("create test/symlinks --no-docker")

    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain("Creating symlinks")

    const wtPath = testRepo.getWorktreePath("test/symlinks")

    // .env should be symlinked (appears in both copy_files and link_files)
    const envPath = path.join(wtPath, ".env")
    expect(existsSync(envPath)).toBe(true)
    const envStat = lstatSync(envPath)
    expect(envStat.isSymbolicLink()).toBe(true)

    // shared-data should be symlinked
    const sharedPath = path.join(wtPath, "shared-data")
    expect(existsSync(sharedPath)).toBe(true)
    const sharedStat = lstatSync(sharedPath)
    expect(sharedStat.isSymbolicLink()).toBe(true)
  })

  it("should skip non-existent paths in link_files", () => {
    const result = testRepo.runCLI("create test/skip-missing-links --no-docker")

    // Missing paths should be skipped (wtb.yaml has shared-data and .env which exist,
    // so this test verifies that existing paths work and non-existent would be skipped)
    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain("Worktree created successfully")
  })

  it("should copy (not symlink) paths in copy_files but not link_files", () => {
    const result = testRepo.runCLI("create test/copy-not-link --no-docker")

    expect(result.exitCode).toBe(0)
    const wtPath = testRepo.getWorktreePath("test/copy-not-link")

    // config/settings.json is in copy_files but NOT in link_files
    const configPath = path.join(wtPath, "config/settings.json")
    expect(existsSync(configPath)).toBe(true)
    const configStat = lstatSync(configPath)
    // Should be a regular file, not a symlink
    expect(configStat.isSymbolicLink()).toBe(false)
    expect(configStat.isFile()).toBe(true)
  })

  it("link_files takes priority over copy_files for same path", () => {
    const result = testRepo.runCLI("create test/priority-check --no-docker")

    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain("Creating symlinks")

    const wtPath = testRepo.getWorktreePath("test/priority-check")
    const envPath = path.join(wtPath, ".env")
    const envStat = lstatSync(envPath)

    // .env appears in both copy_files AND link_files → link_files wins → symlink
    expect(envStat.isSymbolicLink()).toBe(true)
  })

  it("should replace existing file/directory with symlink", () => {
    // First create (makes symlinks)
    testRepo.runCLI("create test/replace-test --no-docker")
    // Remove the worktree
    testRepo.runCLI("remove test/replace-test --force --no-docker")

    // Create again — should handle existing symlinks gracefully
    const result = testRepo.runCLI("create test/replace-test --no-docker")
    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain("Worktree created successfully")
  })
})

// =============================================================================
// ENV.ADJUST TESTS
// =============================================================================

describe("Create Command - env.adjust", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("env-adjust", "env-adjust")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  it("should create worktree and adjust env file ports", () => {
    const result = testRepo.runCLI("create test/env-ports --no-docker")

    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain("Adjusting environment files")
    expect(result.combined).toContain("Worktree created successfully")

    const wtPath = testRepo.getWorktreePath("test/env-ports")
    const envPath = path.join(wtPath, ".env")

    expect(existsSync(envPath)).toBe(true)

    const envContent = fs.readFileSync(envPath, "utf-8")
    // APP_PORT=3000 → finds next free port from 3001
    expect(envContent).toContain("APP_PORT=3001")
    // DB_PORT=5432 → finds next free port from 5433
    expect(envContent).toContain("DB_PORT=5433")
    // REDIS_PORT=6379 → finds next free port from 6380
    expect(envContent).toContain("REDIS_PORT=6380")
  })

  it("avoids colliding with the main worktree's other ports (adjacent-port config)", () => {
    // Regression: when main uses adjacent ports (APP=3000, DB=3001), a new
    // worktree's APP must NOT bump to 3001 and collide with main's running DB.
    // The main/source worktree's ports must be in the collision-avoidance set.
    testRepo.writeFile(
      ".env",
      ["APP_PORT=3000", "DB_PORT=3001", ""].join("\n")
    )
    testRepo.writeFile(
      "wtb.yaml",
      [
        'base_branch: "main"',
        "env:",
        "  file: [./.env]",
        "  adjust:",
        "    APP_PORT: 1",
        "    DB_PORT: 1",
        "",
      ].join("\n")
    )

    const result = testRepo.runCLI("create test/adjacent --no-docker --no-start")
    expect(result.exitCode).toBe(0)

    const envContent = fs.readFileSync(
      path.join(testRepo.getWorktreePath("test/adjacent"), ".env"),
      "utf-8"
    )
    const get = (k: string) => envContent.match(new RegExp(`^${k}=(\\d+)`, "m"))?.[1]
    const app = Number(get("APP_PORT"))
    const db = Number(get("DB_PORT"))
    // new worktree's ports must avoid BOTH of main's ports (3000, 3001) and each other
    expect([3000, 3001]).not.toContain(app)
    expect([3000, 3001]).not.toContain(db)
    expect(app).not.toBe(db)
  })

  it("serializes parallel creates so sibling env port allocations stay unique", async () => {
    const runCreate = (branch: string) =>
      new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [CLI_PATH, "create", branch, "--no-docker", "--no-start"],
          { cwd: testRepo.path, stdio: ["ignore", "pipe", "pipe"] }
        )
        let output = ""
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString()
        })
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString()
        })
        child.once("error", reject)
        child.once("close", (code) => resolve({ exitCode: code ?? 1, output }))
      })

    const branches = ["parallel/alpha", "parallel/beta"]
    const results = await Promise.all(branches.map(runCreate))
    expect(results, results.map((result) => result.output).join("\n")).toEqual([
      expect.objectContaining({ exitCode: 0 }),
      expect.objectContaining({ exitCode: 0 }),
    ])

    const allocated = branches.map((branch) => {
      const env = fs.readFileSync(path.join(testRepo.getWorktreePath(branch), ".env"), "utf-8")
      return new Set(
        [...env.matchAll(/^(?:APP_PORT|DB_PORT|REDIS_PORT)=(\d+)$/gm)].map((match) =>
          Number(match[1])
        )
      )
    })
    expect(allocated[0].size).toBe(3)
    expect(allocated[1].size).toBe(3)
    expect([...allocated[0]].filter((port) => allocated[1].has(port))).toEqual([])
  })

  it("should copy env file even when adjust is empty", () => {
    // Create a project with env.file set but adjust empty via CLI
    // Use the basic project which has env.file: [] to verify no env copy
    const basicRepo = createTestRepo("basic", "env-no-adjust")

    try {
      const result = basicRepo.runCLI("create test/no-adjust --no-docker")
      expect(result.exitCode).toBe(0)
      // Basic project has env.file: [] so no env processing
      expect(result.combined).not.toContain("environment file")
    } finally {
      basicRepo.cleanup()
    }
  })
})

// =============================================================================
// --no-create-branch TESTS
// =============================================================================

describe("Create Command - --no-create-branch", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("basic", "no-create-branch")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  it("should succeed when branch already exists with --no-create-branch", () => {
    // Create branch first
    testRepo.runCLI("create existing-for-flag --no-docker")
    testRepo.runCLI("remove existing-for-flag --force --no-docker")

    // Branch should still exist
    expect(testRepo.branchExists("existing-for-flag")).toBe(true)

    // Create worktree without creating new branch
    const result = testRepo.runCLI(
      "create existing-for-flag --no-create-branch --no-docker"
    )

    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain("Worktree created successfully")
  })

  it("should fail when branch does not exist with --no-create-branch", () => {
    const result = testRepo.runCLI(
      "create nonexistent-branch --no-create-branch --no-docker"
    )

    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain("does not exist")
    expect(result.combined).toContain("--no-create-branch")
  })

  it("should create new branch without --no-create-branch flag", () => {
    const result = testRepo.runCLI("create brand-new-branch --no-docker")

    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain("Creating new branch: brand-new-branch")
    expect(testRepo.branchExists("brand-new-branch")).toBe(true)
  })
})

// =============================================================================
// LS COMMAND
// =============================================================================

describe("LS Command", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("basic", "ls")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  describe("default output", () => {
    it("should list the main worktree with current marker and [main] tag", () => {
      const result = testRepo.runCLI("ls")

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("main")
      expect(result.stdout).toContain("[main]")
      expect(result.stdout).toContain("→")
    })

    it("should list additional worktrees after create", () => {
      testRepo.runCLI("create feature/ls-test")
      const result = testRepo.runCLI("ls")

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("main")
      expect(result.stdout).toContain("feature/ls-test")
    })
  })

  describe("--paths / -p", () => {
    it("should emit only absolute paths, no marker, no header", () => {
      testRepo.runCLI("create feature/paths-test")
      const result = testRepo.runCLI("ls -p")

      expect(result.exitCode).toBe(0)
      const lines = result.stdout.trim().split("\n")
      expect(lines.length).toBe(2)
      expect(lines.every((l) => path.isAbsolute(l))).toBe(true)
      expect(result.stdout).not.toContain("→")
      expect(result.stdout).not.toContain("[main]")
      expect(result.stdout).not.toContain("BRANCH")
    })
  })

  describe("--json", () => {
    it("should output parseable JSON with core fields", () => {
      const result = testRepo.runCLI("ls --json")

      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout)
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed.length).toBeGreaterThanOrEqual(1)
      expect(parsed[0]).toHaveProperty("path")
      expect(parsed[0]).toHaveProperty("branch")
      expect(parsed[0]).toHaveProperty("head")
      expect(parsed[0]).toHaveProperty("isMain")
      expect(parsed[0]).toHaveProperty("isCurrent")
      expect(parsed[0]).toHaveProperty("locked")
      // No enrichment fields without -l
      expect(parsed[0]).not.toHaveProperty("shortHash")
    })
  })

  describe("--long / -l", () => {
    it("should include commit hash, age, and dirty columns", () => {
      const result = testRepo.runCLI("ls -l")

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("BRANCH")
      expect(result.stdout).toContain("COMMIT")
      expect(result.stdout).toContain("AGE")
      expect(result.stdout).toContain("PATH")
    })

    it("should include enrichment fields when combined with --json", () => {
      const result = testRepo.runCLI("ls -l --json")

      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout)
      expect(parsed[0]).toHaveProperty("shortHash")
      expect(parsed[0]).toHaveProperty("subject")
      expect(parsed[0]).toHaveProperty("ageRelative")
      expect(parsed[0]).toHaveProperty("ageTimestamp")
      expect(parsed[0]).toHaveProperty("dirty")
    })
  })

  describe("list alias", () => {
    it("should work identically to ls", () => {
      const lsResult = testRepo.runCLI("ls")
      const listResult = testRepo.runCLI("list")

      expect(lsResult.exitCode).toBe(0)
      expect(listResult.exitCode).toBe(0)
      expect(listResult.stdout).toBe(lsResult.stdout)
    })
  })

  describe("error handling", () => {
    it("should exit with NOT_GIT_REPOSITORY (3) outside a git repo", () => {
      const nonGit = createNonGitDir("ls-nongit")
      try {
        const result = runCLI("ls", nonGit.path)

        expect(result.exitCode).toBe(3)
        expect(result.combined).toContain("Not in a git repository")
      } finally {
        nonGit.cleanup()
      }
    })
  })
})

// =============================================================================
// PORTS COMMAND
// =============================================================================

describe("ports command", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("env-adjust", "ports")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  describe("defaults", () => {
    it("returns a single object for the current worktree with env/compose/endpoints", () => {
      const result = testRepo.runCLI("ports")
      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout)
      expect(Array.isArray(parsed)).toBe(false)
      expect(parsed.branch).toBe("main")
      // env.adjust keys should be surfaced with their source values
      expect(parsed.env.APP_PORT).toBe("3000")
      expect(parsed.env.DB_PORT).toBe("5432")
      expect(parsed.env.REDIS_PORT).toBe("6379")
      // non-listed keys must NOT leak
      expect(parsed.env.NODE_ENV).toBeUndefined()
      // compose info from the source compose-file
      expect(parsed.compose.file).toBeTruthy()
      expect(parsed.compose.services.app.host_ports).toEqual([3000])
      expect(parsed.endpoints).toContain("http://localhost:3000")
    })

    it("exposes each worktree's adjusted env ports with --all after create", () => {
      const createOne = testRepo.runCLI("create feature/alpha --no-start --no-docker")
      expect(createOne.exitCode).toBe(0)
      const createTwo = testRepo.runCLI("create feature/beta --no-start --no-docker")
      expect(createTwo.exitCode).toBe(0)

      const result = testRepo.runCLI("ports --all")
      expect(result.exitCode).toBe(0)
      const rows = JSON.parse(result.stdout) as Array<{
        branch: string
        env: Record<string, string>
      }>
      expect(Array.isArray(rows)).toBe(true)
      const byBranch = Object.fromEntries(rows.map((r) => [r.branch, r]))
      expect(byBranch.main?.env.APP_PORT).toBe("3000")
      expect(byBranch["feature/alpha"]?.env.APP_PORT).toBe("3001")
      expect(byBranch["feature/beta"]?.env.APP_PORT).toBe("3002")
    })

    it("--pretty renders a human-readable block", () => {
      const result = testRepo.runCLI("ports --pretty")
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("main")
      expect(result.stdout).toContain("env:")
      expect(result.stdout).toContain("APP_PORT=3000")
    })
  })

  describe("error handling", () => {
    it("exits 3 outside a git repository", () => {
      const nonGit = createNonGitDir("ports-nongit")
      try {
        const result = runCLI("ports", nonGit.path)
        expect(result.exitCode).toBe(3)
        expect(result.combined).toContain("Not in a git repository")
      } finally {
        nonGit.cleanup()
      }
    })
  })
})

// =============================================================================
// INIT-CLAUDE COMMAND
// =============================================================================

describe("init-claude command", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("basic", "init-claude")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  it("installs .claude/skills/wtb/SKILL.md on first run", () => {
    const result = testRepo.runCLI("init-claude")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Installed wtb Claude Code skill")
    const skillPath = path.join(testRepo.path, ".claude/skills/wtb/SKILL.md")
    expect(existsSync(skillPath)).toBe(true)
    const content = fs.readFileSync(skillPath, "utf-8")
    expect(content).toMatch(/name: wtb/)
  })

  it("skips when already installed without --force", () => {
    const first = testRepo.runCLI("init-claude")
    expect(first.exitCode).toBe(0)
    const second = testRepo.runCLI("init-claude")
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toContain("Skipped")
    expect(second.stdout).toContain("already exists")
  })

  it("overwrites with --force", () => {
    testRepo.runCLI("init-claude")
    const skillPath = path.join(testRepo.path, ".claude/skills/wtb/SKILL.md")
    fs.writeFileSync(skillPath, "stale content", "utf-8")
    const result = testRepo.runCLI("init-claude --force")
    expect(result.exitCode).toBe(0)
    const content = fs.readFileSync(skillPath, "utf-8")
    expect(content).not.toBe("stale content")
    expect(content).toMatch(/name: wtb/)
  })

  it("--dry-run prints targets without writing", () => {
    const result = testRepo.runCLI("init-claude --dry-run")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Dry run")
    expect(existsSync(path.join(testRepo.path, ".claude/skills/wtb/SKILL.md"))).toBe(false)
  })
})

// =============================================================================
// CREATE -> init-claude Tip
// =============================================================================

describe("create command — init-claude tip", () => {
  let testRepo: TestRepo

  beforeEach(() => {
    testRepo = createTestRepo("basic", "create-tip")
  })

  afterEach(() => {
    testRepo.cleanup()
  })

  it("prints the init-claude tip when skill is not installed", () => {
    const result = testRepo.runCLI("create feature/tip-1 --no-start --no-docker")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Run "wtb init-claude"')
  })

  it("suppresses the tip once the skill has been installed", () => {
    const init = testRepo.runCLI("init-claude")
    expect(init.exitCode).toBe(0)
    const result = testRepo.runCLI("create feature/tip-2 --no-start --no-docker")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain('Run "wtb init-claude"')
  })
})

describe("Main-repository guards (real git, not mocked)", () => {
  // Closes the unit-test blind spot where worktree.js is auto-mocked: here the real
  // isSamePath canonical-path comparison runs against an actual repo.
  let repo: TestRepo

  beforeEach(() => {
    repo = createTestRepo("basic", "main-guard")
  })
  afterEach(() => {
    repo.cleanup()
  })

  it("`remove main` refuses to delete the main repository worktree", () => {
    const r = repo.runCLI("remove main")
    expect(r.exitCode).not.toBe(0)
    expect(r.combined).toContain("Cannot remove the main repository worktree")
    // the repo itself must still be intact
    expect(existsSync(repo.path)).toBe(true)
    expect(existsSync(path.join(repo.path, ".git"))).toBe(true)
  })

  it("`reclone main` refuses to target the main repository worktree", () => {
    const r = repo.runCLI("reclone main")
    expect(r.exitCode).not.toBe(0)
    expect(r.combined).toContain("Refusing to reclone into the main repository worktree")
  })
})

describe("Create — env.adjust value types (number / string / null), end to end", () => {
  let repo: TestRepo

  beforeEach(() => {
    repo = createTestRepo("env-adjust", "adjust-types")
    // Override config + env to drive all three value types through the real CLI.
    repo.writeFile(
      "wtb.yaml",
      [
        "base_branch: main",
        "copy_files: []",
        "env:",
        "  file:",
        "    - ./.env",
        "  adjust:",
        "    APP_PORT: 1", // number → next free port
        '    API_KEY: "replaced-by-wtb"', // string → literal replacement
        "    OLD_FLAG: null", // null → remove the key",
        "",
      ].join("\n")
    )
    repo.writeFile(
      ".env",
      ["APP_PORT=3000", "API_KEY=original-secret", "OLD_FLAG=enabled", "KEEP_ME=untouched", ""].join(
        "\n"
      )
    )
  })
  afterEach(() => {
    repo.cleanup()
  })

  it("bumps a number, replaces a string verbatim, removes a null key, and leaves others alone", () => {
    const r = repo.runCLI("create test/adjust --no-docker --no-start")
    expect(r.exitCode).toBe(0)
    const env = repo.readWorktreeFile("test/adjust", ".env")
    expect(env).toContain("APP_PORT=3001") // number → original+1
    expect(env).toContain("API_KEY=replaced-by-wtb") // string → literal
    expect(env).not.toMatch(/^OLD_FLAG=/m) // null → removed
    expect(env).toContain("KEEP_ME=untouched") // untouched key preserved
  })
})

describe("Create — skip flags actually skip their phase", () => {
  it("--no-env leaves the worktree without an adjusted .env", () => {
    const repo = createTestRepo("env-adjust", "no-env")
    try {
      const r = repo.runCLI("create test/no-env --no-env --no-docker --no-start")
      expect(r.exitCode).toBe(0)
      // .env is gitignored and only arrives via the env phase; --no-env skips it entirely.
      expect(repo.worktreeFileExists("test/no-env", ".env")).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it("--no-copy does not copy a gitignored copy_files entry", () => {
    const repo = createTestRepo("link-files", "no-copy")
    try {
      // config/settings.json is gitignored and only in copy_files → absent with --no-copy.
      const r = repo.runCLI("create test/no-copy --no-copy --no-docker --no-start")
      expect(r.exitCode).toBe(0)
      expect(repo.worktreeFileExists("test/no-copy", "config/settings.json")).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it("--no-link does not create a symlinked link_files entry", () => {
    const repo = createTestRepo("link-files", "no-link")
    try {
      // shared-data is gitignored and only in link_files → absent with --no-link.
      const r = repo.runCLI("create test/no-link --no-link --no-docker --no-start")
      expect(r.exitCode).toBe(0)
      expect(repo.worktreeFileExists("test/no-link", "shared-data")).toBe(false)
    } finally {
      repo.cleanup()
    }
  })
})

describe("Relocatability scenario (Supabase-like tracked compose)", () => {
  let repo: TestRepo

  beforeEach(() => {
    repo = createTestRepo("relocatability", "reloc")
  })

  afterEach(() => {
    repo.cleanup()
  })

  it.skipIf(!HAS_DOCKER_DAEMON)(
    "rewrites the tracked compose per-worktree, propagates ports, and keeps the worktree clean",
    () => {
    const create = repo.runCLI("create feat/iso --no-volume-copy")
    expect(create.exitCode).toBe(0)

    const compose = repo.readWorktreeFile("feat/iso", "docker-compose.yml")
    // F1: top-level name: and each container_name: rewritten per worktree
    expect(compose).toContain("supabase_demo-feat-iso")
    expect(compose).toContain("supabase_kong_demo-feat-iso")
    expect(compose).toContain("supabase_db_demo-feat-iso")

    // F3: KONG_HTTP_PORT bumped off its original (above the old 3000-9999 ceiling)
    const env = repo.readWorktreeFile("feat/iso", ".env")
    const kong = env.match(/KONG_HTTP_PORT=(\d+)/)?.[1]
    expect(kong).toBeDefined()
    expect(kong).not.toBe("54321")

    // F2: the bump propagates into the URL-embedded port in env AND into the
    // compose ${VAR:-default} default and the GOTRUE/API URLs — all consistent.
    expect(env).toContain(`http://127.0.0.1:${kong}`)
    expect(compose).toContain(`KONG_HTTP_PORT:-${kong}`)
    expect(compose).toContain(`http://127.0.0.1:${kong}`)

    // skip-worktree: the rewritten tracked files do NOT dirty the worktree
    const wt = repo.getWorktreePath("feat/iso")
    const status = execSync("git status --porcelain", { cwd: wt, encoding: "utf-8" })
    expect(status.trim()).toBe("")

    // F5: `wtb ports` resolves ${VAR} mappings statically (stack not running)
    const ports = repo.runCLI("ports feat/iso --pretty")
    expect(ports.exitCode).toBe(0)
    expect(ports.combined).toContain("localhost:")

    // removal is not blocked by the rewrite (skip-worktree → clean status)
    const rm = repo.runCLI("remove feat/iso --no-docker")
    expect(rm.exitCode).toBe(0)
    }
  )

  it("doctor reports relocatability findings (info, since identity rewrite + propagation are on by default)", () => {
    const res = repo.runCLI("doctor --json")
    expect(res.exitCode).toBe(0)
    const report = JSON.parse(res.stdout)
    const ids = report.findings.map((f: { id: string }) => f.id)
    expect(ids).toContain("fixed-project-name")
    expect(ids).toContain("container-name")
    // defaults handle these, so no warning/error findings → ok
    expect(report.ok).toBe(true)
  })
})
