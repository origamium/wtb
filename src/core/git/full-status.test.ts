import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as exec from "../../utils/exec.js"
import { collectFullWorktreeStatus, inspectWorktreeDirty } from "./full-status.js"
import { listWorktrees, markWtbManagedFile } from "./worktree.js"

let dir: string
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim()
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "wtb-full-"))
  git("init", "-b", "main")
  git("config", "user.name", "Test")
  git("config", "user.email", "test@example.com")
  writeFileSync(path.join(dir, "file"), "initial\n")
  git("add", "file")
  git("commit", "-m", "initial")
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("full worktree status", () => {
  it("reports divergent and detached worktrees against configured base", async () => {
    const feature = path.join(dir, "feature")
    git("worktree", "add", "-b", "feature", feature)
    writeFileSync(path.join(feature, "feature-file"), "feature\n")
    execFileSync("git", ["add", "feature-file"], { cwd: feature })
    execFileSync("git", ["commit", "-m", "feature"], { cwd: feature, stdio: "pipe" })
    writeFileSync(path.join(dir, "file"), "main change\n")
    git("commit", "-am", "main")
    const detached = path.join(dir, "detached")
    git("worktree", "add", "--detach", detached, "HEAD~1")
    const rows = await collectFullWorktreeStatus(listWorktrees(dir), dir, "main")
    expect(rows.find((row) => row.branch === "feature")).toMatchObject({
      ahead: 1,
      behind: 1,
      dirty: false,
      baseBranch: "main",
    })
    expect(rows.find((row) => row.detached)).toMatchObject({ ahead: 0, behind: 1, dirty: false })
  })

  it("falls back for old Git and reports unknown base as null", async () => {
    const original = exec.execGitSafe
    const spy = vi.spyOn(exec, "execGitSafe").mockImplementation((args, options) => {
      if (args[0] === "for-each-ref") throw new Error("unknown field name: ahead-behind")
      return original(args, options)
    })
    const rows = await collectFullWorktreeStatus(listWorktrees(dir), dir, "main")
    expect(rows[0]).toMatchObject({ ahead: 0, behind: 0, dirty: false })
    expect(spy.mock.calls.some(([args]) => args[0] === "rev-list")).toBe(true)
    const invalid = await collectFullWorktreeStatus(listWorktrees(dir), dir, "missing")
    expect(invalid[0]).toMatchObject({ ahead: null, behind: null, dirty: false })
    expect(invalid[0].enrichmentError).toContain("base_branch")
  })

  it("finds managed-file edits and mode changes hidden by skip-worktree", () => {
    writeFileSync(path.join(dir, "file"), "generated\n")
    expect(markWtbManagedFile(dir, "file")).toBe(true)
    expect(git("status", "--porcelain")).toBe("")
    expect(inspectWorktreeDirty(dir)).toBe(false)
    writeFileSync(path.join(dir, "file"), "user changed\n")
    expect(inspectWorktreeDirty(dir)).toBe(true)
    writeFileSync(path.join(dir, "file"), "generated\n")
    chmodSync(path.join(dir, "file"), 0o755)
    expect(inspectWorktreeDirty(dir)).toBe(true)
    chmodSync(path.join(dir, "file"), 0o644)
    unlinkSync(path.join(dir, "file"))
    expect(inspectWorktreeDirty(dir)).toBe(true)
  })

  it("does not report broken worktrees as clean", async () => {
    const rows = await collectFullWorktreeStatus(
      [
        {
          path: path.join(dir, "gone"),
          branch: "gone",
          head: git("rev-parse", "HEAD"),
          prunable: true,
        },
      ],
      dir,
      "main"
    )
    expect(rows[0].dirty).toBeNull()
    expect(rows[0].enrichmentError).toBeTruthy()
  })

  it("reports unknown dirty state for unmanaged skip-worktree changes without changing the index", async () => {
    git("update-index", "--skip-worktree", "--", "file")
    writeFileSync(path.join(dir, "file"), "hidden user change\n")
    expect(git("status", "--porcelain")).toBe("")

    const rows = await collectFullWorktreeStatus(listWorktrees(dir), dir, "main")

    expect(rows[0]).toMatchObject({ dirty: null, ahead: 0, behind: 0 })
    expect(rows[0].enrichmentError).toContain("skip-worktree")
    expect(git("ls-files", "-v", "--", "file")).toMatch(/^S /)
    expect(readFileSync(path.join(dir, "file"), "utf8")).toBe("hidden user change\n")
  })

  it.each([
    false,
    true,
  ])("reports assume-unchanged as unknown even when managed=%s", async (managed) => {
    if (managed) {
      writeFileSync(path.join(dir, "file"), "generated\n")
      expect(markWtbManagedFile(dir, "file")).toBe(true)
    }
    git("update-index", "--assume-unchanged", "--", "file")
    writeFileSync(path.join(dir, "file"), "hidden user change\n")
    expect(git("status", "--porcelain")).toBe("")
    const initialFlags = git("ls-files", "-v", "--", "file")
    expect(initialFlags).toMatch(/^[hs] /)

    const rows = await collectFullWorktreeStatus(listWorktrees(dir), dir, "main")

    expect(rows[0].dirty).toBeNull()
    expect(rows[0].enrichmentError).toContain("assume-unchanged")
    expect(git("ls-files", "-v", "--", "file")).toBe(initialFlags)
    expect(readFileSync(path.join(dir, "file"), "utf8")).toBe("hidden user change\n")
  })
})
