/**
 * @fileoverview parseWorktreeList のテスト
 * git worktree list --porcelain 出力のパース動作を検証
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execGitSafe } from "../../utils/exec.js"
import {
  clearSkipWorktree,
  createWorktree,
  gitHashObject,
  isSamePath,
  listSkipWorktreePaths,
  loadWtbManagedManifest,
  markWtbManagedFile,
  parseWorktreeList,
} from "./worktree.js"

// createWorktree が組む git 引数を検証するため exec 層だけを mock する。
// isSamePath / parseWorktreeList は純関数なので影響を受けない。
vi.mock("../../utils/exec.js")

describe("createWorktree", () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    // isGitRepository は rev-parse --is-inside-work-tree の "true" を確認する。
    vi.mocked(execGitSafe).mockReturnValue("true")
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it("creates a new branch off the base branch", () => {
    createWorktree("feature/x", "/wt/feature-x", { baseBranch: "main" })
    expect(execGitSafe).toHaveBeenCalledWith(
      ["worktree", "add", "/wt/feature-x", "-b", "feature/x", "main"],
      { cwd: undefined }
    )
  })

  it("checks out an existing branch without -b", () => {
    createWorktree("feature/x", "/wt/feature-x", { useExistingBranch: true })
    expect(execGitSafe).toHaveBeenCalledWith(
      ["worktree", "add", "/wt/feature-x", "--end-of-options", "feature/x"],
      {
        cwd: undefined,
      }
    )
  })

  it("creates a tracking branch from the remote ref when trackFrom is set", () => {
    createWorktree("feature/x", "/wt/feature-x", {
      baseBranch: "main",
      trackFrom: "origin/feature/x",
    })
    expect(execGitSafe).toHaveBeenCalledWith(
      ["worktree", "add", "/wt/feature-x", "-b", "feature/x", "--track", "origin/feature/x"],
      { cwd: undefined }
    )
  })
})

describe("wtb-managed manifest (B1)", () => {
  let dir: string
  let manifestPath: string

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtb-manifest-"))
    manifestPath = path.join(dir, "wtb-managed.json")
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /**
   * execGitSafe を期待引数に応じて返り値を切り替える helper。
   * - ls-files --error-unmatch: tracked かどうか (throw で untracked)
   * - hash-object: その path の blob sha
   * - rev-parse --git-path wtb-managed.json: manifest のパス (real temp file)
   * - update-index: no-op
   */
  const wireGit = (opts: {
    tracked?: boolean
    shaByPath?: Record<string, string>
  }): ReturnType<typeof vi.fn> => {
    const fn = vi.fn((args: string[]) => {
      if (args[0] === "ls-files") {
        return opts.tracked === false ? "" : `${args[args.length - 1]}\0`
      }
      if (args[0] === "hash-object") {
        const p = args[args.length - 1]
        const sha = opts.shaByPath?.[p]
        if (sha === undefined) throw new Error("no sha")
        return sha
      }
      if (args[0] === "rev-parse") return manifestPath
      if (args[0] === "update-index") return ""
      return ""
    })
    vi.mocked(execGitSafe).mockImplementation(fn as never)
    return fn
  }

  it("markWtbManagedFile sets skip-worktree AND records the blob sha into the manifest", () => {
    const git = wireGit({ tracked: true, shaByPath: { "docker-compose.yml": "abc123" } })

    expect(markWtbManagedFile(dir, "docker-compose.yml")).toBe(true)

    // skip-worktree が立つこと
    expect(git).toHaveBeenCalledWith(
      ["update-index", "--skip-worktree", "--", "docker-compose.yml"],
      { cwd: dir }
    )
    // manifest に sha が記録されること
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    expect(manifest).toEqual({
      version: 1,
      files: { "docker-compose.yml": "abc123" },
    })
  })

  it("markWtbManagedFile is a no-op for an untracked file (no skip-worktree, no manifest)", () => {
    const git = wireGit({ tracked: false })

    expect(markWtbManagedFile(dir, "untracked.yml")).toBe(true)

    expect(git).not.toHaveBeenCalledWith(
      ["update-index", "--skip-worktree", "--", "untracked.yml"],
      { cwd: dir }
    )
    expect(fs.existsSync(manifestPath)).toBe(false)
  })

  it("reports a managed metadata failure instead of hiding it", () => {
    const git = wireGit({ tracked: true, shaByPath: {} })

    expect(markWtbManagedFile(dir, "docker-compose.yml")).toBe(false)
    expect(git).not.toHaveBeenCalledWith(
      ["update-index", "--skip-worktree", "--", "docker-compose.yml"],
      { cwd: dir }
    )
  })

  it("recording a second managed file merges into the existing manifest", () => {
    wireGit({
      tracked: true,
      shaByPath: { "docker-compose.yml": "aaa", ".env": "bbb" },
    })

    markWtbManagedFile(dir, "docker-compose.yml")
    markWtbManagedFile(dir, ".env")

    expect(loadWtbManagedManifest(dir)).toEqual({
      "docker-compose.yml": "aaa",
      ".env": "bbb",
    })
  })

  it("loadWtbManagedManifest returns {} only when the manifest is absent", () => {
    wireGit({ tracked: true })
    expect(loadWtbManagedManifest(dir)).toEqual({})
  })

  it("loads the legacy flat manifest format", () => {
    wireGit({ tracked: true })
    fs.writeFileSync(manifestPath, JSON.stringify({ ".env": "legacy-sha" }))
    expect(loadWtbManagedManifest(dir)).toEqual({ ".env": "legacy-sha" })
  })

  it("fails closed for a corrupt or unsafe manifest", () => {
    wireGit({ tracked: true })
    fs.writeFileSync(manifestPath, "{ not json")
    expect(() => loadWtbManagedManifest(dir)).toThrow("Invalid wtb-managed manifest")

    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ version: 1, files: { "../outside": "sha" } })
    )
    expect(() => loadWtbManagedManifest(dir)).toThrow("invalid file entry")
  })

  it("gitHashObject returns the trimmed sha, or null on error", () => {
    wireGit({ tracked: true, shaByPath: { "a.txt": "deadbeef" } })
    expect(gitHashObject(dir, "a.txt")).toBe("deadbeef")
    expect(gitHashObject(dir, "missing.txt")).toBeNull()
  })

  it("clearSkipWorktree issues --no-skip-worktree (best-effort)", () => {
    const git = wireGit({ tracked: true })
    clearSkipWorktree(dir, "docker-compose.yml")
    expect(git).toHaveBeenCalledWith(
      ["update-index", "--no-skip-worktree", "--", "docker-compose.yml"],
      { cwd: dir }
    )
  })

  it("lists every uppercase S-tagged skip-worktree path from NUL-delimited Git output", () => {
    vi.mocked(execGitSafe).mockReturnValue(
      "H ordinary.txt\0S path with spaces.yml\0S line\nbreak.env\0M modified.txt\0"
    )

    expect(listSkipWorktreePaths(dir)).toEqual(["path with spaces.yml", "line\nbreak.env"])
    expect(execGitSafe).toHaveBeenCalledWith(["ls-files", "-v", "-z", "--"], {
      cwd: dir,
      preserveLeadingWhitespace: true,
    })
  })

  it.each([
    ["h", "assume-only.txt"],
    ["s", "skip-and-assume.env"],
  ])("fails closed for lowercase %s because assume-unchanged hides changes", (tag, file) => {
    vi.mocked(execGitSafe).mockReturnValue(`${tag} ${file}\0`)
    expect(() => listSkipWorktreePaths(dir)).toThrow(
      `Tracked path '${file}' has assume-unchanged set`
    )
  })

  it("fails closed instead of returning a partial skip-worktree list for malformed output", () => {
    vi.mocked(execGitSafe).mockReturnValue("S valid.yml\0malformed\0")
    expect(() => listSkipWorktreePaths(dir)).toThrow("Unexpected output")
  })
})

describe("isSamePath", () => {
  it("treats identical paths as the same", () => {
    expect(isSamePath("/project", "/project")).toBe(true)
  })

  it("normalizes non-canonical but equivalent paths (realpath fallback)", () => {
    // 存在しないパスは realpath が失敗し path.resolve にフォールバックする。
    expect(isSamePath("/project/", "/project")).toBe(true)
    expect(isSamePath("/a/b/../b", "/a/b")).toBe(true)
  })

  it("distinguishes genuinely different paths", () => {
    expect(isSamePath("/project", "/project-feature")).toBe(false)
  })

  it("resolves symlinks so a link and its target compare equal", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtb-samepath-"))
    try {
      const real = path.join(dir, "real")
      const link = path.join(dir, "link")
      fs.mkdirSync(real)
      fs.symlinkSync(real, link)
      // 文字列としては異なるが、同じ実体を指すので true。
      expect(isSamePath(link, real)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("parseWorktreeList", () => {
  it("returns empty array for empty input", () => {
    expect(parseWorktreeList("")).toEqual([])
    expect(parseWorktreeList("   \n  ")).toEqual([])
  })

  it("parses a single main worktree", () => {
    const input = [
      "worktree /Users/me/proj",
      "HEAD abc123def456abc123def456abc123def456abcd",
      "branch refs/heads/main",
      "",
    ].join("\n")

    const result = parseWorktreeList(input)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      path: "/Users/me/proj",
      branch: "main",
      head: "abc123def456abc123def456abc123def456abcd",
    })
    expect(result[0].locked).toBeUndefined()
    expect(result[0].prunable).toBeUndefined()
    expect(result[0].bare).toBeUndefined()
    expect(result[0].detached).toBeUndefined()
  })

  it("parses multiple worktrees", () => {
    const input = [
      "worktree /Users/me/proj",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /Users/me/worktree-feature",
      "HEAD def456",
      "branch refs/heads/feature",
      "",
    ].join("\n")

    const result = parseWorktreeList(input)
    expect(result).toHaveLength(2)
    expect(result[0].branch).toBe("main")
    expect(result[1].branch).toBe("feature")
    expect(result[1].path).toBe("/Users/me/worktree-feature")
  })

  it("captures locked flag (no reason)", () => {
    const input = [
      "worktree /Users/me/wt-locked",
      "HEAD abc",
      "branch refs/heads/locked-branch",
      "locked",
      "",
    ].join("\n")

    const result = parseWorktreeList(input)
    expect(result[0].locked).toBe(true)
  })

  it("captures locked flag with reason", () => {
    const input = [
      "worktree /Users/me/wt-locked",
      "HEAD abc",
      "branch refs/heads/locked-branch",
      "locked WIP: preserving for review",
      "",
    ].join("\n")

    const result = parseWorktreeList(input)
    expect(result[0].locked).toBe(true)
  })

  it("captures prunable flag", () => {
    const input = [
      "worktree /Users/me/wt-gone",
      "HEAD abc",
      "branch refs/heads/gone-branch",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n")

    const result = parseWorktreeList(input)
    expect(result[0].prunable).toBe(true)
  })

  it("captures bare flag on main repo", () => {
    const input = [
      "worktree /Users/me/bare.git",
      "bare",
      "",
      "worktree /Users/me/wt-a",
      "HEAD abc",
      "branch refs/heads/a",
      "",
    ].join("\n")

    const result = parseWorktreeList(input)
    expect(result).toHaveLength(2)
    expect(result[0].bare).toBe(true)
    expect(result[1].bare).toBeUndefined()
  })

  it("marks detached HEAD with branch label and flag", () => {
    const input = ["worktree /Users/me/wt-detached", "HEAD abc123", "detached", ""].join("\n")

    const result = parseWorktreeList(input)
    expect(result[0].branch).toBe("(detached)")
    expect(result[0].detached).toBe(true)
  })

  it("does not set flags when their lines are absent", () => {
    const input = ["worktree /Users/me/proj", "HEAD abc", "branch refs/heads/main", ""].join("\n")

    const result = parseWorktreeList(input)
    expect(result[0].locked).toBeUndefined()
    expect(result[0].prunable).toBeUndefined()
    expect(result[0].bare).toBeUndefined()
    expect(result[0].detached).toBeUndefined()
  })
})
