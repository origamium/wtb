/**
 * @fileoverview Git リポジトリ操作のテスト
 * 新しいディレクトリ構造に対応したテストファイル
 */

import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  REPOSITORY_LOCK_DIR_NAME,
  REPOSITORY_LOCK_OWNER_FILE,
  REPOSITORY_LOCK_STALE_MS,
  acquireRepositoryLock,
  branchExists,
  getCurrentBranch,
  getGitRoot,
  getMainWorktreeRoot,
  getRepositoryContext,
  getRepositoryInfo,
  isGitRepository,
  remoteBranchExists,
  revisionExists,
  withRepositoryLock,
} from "./repository.js"

// Mock dependencies
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}))

describe("Git Repository Operations (Refactored)", () => {
  const testRepoPath = "/tmp/test-repo"
  const temporaryDirectories: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
    )
  })

  async function createTemporaryCommonGitDir(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), "wtb-repository-lock-"))
    temporaryDirectories.push(directory)
    return directory
  }

  describe("isGitRepository", () => {
    it("should return true when in a git repository", () => {
      vi.mocked(execFileSync).mockReturnValue("true\n")

      const result = isGitRepository(testRepoPath)

      expect(result).toBe(true)
      expect(execFileSync).toHaveBeenCalledWith(
        "git",
        ["rev-parse", "--is-inside-work-tree"],
        expect.objectContaining({ cwd: testRepoPath })
      )
    })

    it("should return false when not in a git repository", () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error("Not a git repository")
      })

      const result = isGitRepository("/tmp/not-git")

      expect(result).toBe(false)
    })

    it("should return false for a bare repository response", () => {
      vi.mocked(execFileSync).mockReturnValue("false\n")

      expect(isGitRepository(testRepoPath)).toBe(false)
    })
  })

  describe("getRepositoryContext", () => {
    it("returns canonical current, main and common paths from a linked worktree", () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce("true\n") // inside worktree
        .mockReturnValueOnce("false\n") // not bare
        .mockReturnValueOnce("/path/to/worktree-feature\n") // current root
        .mockReturnValueOnce("/path/to/main/.git\n") // common Git directory
        .mockReturnValueOnce(
          "worktree /path/to/main\0HEAD abc\0branch refs/heads/main\0\0" +
            "worktree /path/to/worktree-feature\0HEAD def\0branch refs/heads/feature\0\0"
        )

      expect(getRepositoryContext("/path/to/worktree-feature/src")).toEqual({
        currentRoot: "/path/to/worktree-feature",
        mainRoot: "/path/to/main",
        commonGitDir: "/path/to/main/.git",
      })
      expect(execFileSync).toHaveBeenCalledWith(
        "git",
        ["worktree", "list", "--porcelain", "-z"],
        expect.objectContaining({ cwd: "/path/to/worktree-feature" })
      )
    })

    it("resolves a relative common Git directory against the invocation directory", () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce("true\n")
        .mockReturnValueOnce("false\n")
        .mockReturnValueOnce("/path/to/main\n")
        .mockReturnValueOnce("../.git\n")
        .mockReturnValueOnce("worktree /path/to/main\0HEAD abc\0\0")

      expect(getRepositoryContext("/path/to/main/src")).toEqual({
        currentRoot: "/path/to/main",
        mainRoot: "/path/to/main",
        commonGitDir: "/path/to/main/.git",
      })
    })

    it("rejects a bare repository explicitly", () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce("true\n") // defensive: inside-worktree says true
        .mockReturnValueOnce("true\n") // bare repository

      expect(() => getRepositoryContext(testRepoPath)).toThrow(
        "Bare git repositories are not supported"
      )
    })

    it("rejects a linked checkout whose primary worktree is bare", () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce("true\n")
        .mockReturnValueOnce("false\n")
        .mockReturnValueOnce("/path/to/linked\n")
        .mockReturnValueOnce("/path/to/bare.git\n")
        .mockReturnValueOnce(
          "worktree /path/to/bare.git\0bare\0\0" +
            "worktree /path/to/linked\0HEAD abc\0branch refs/heads/main\0\0"
        )

      expect(() => getRepositoryContext("/path/to/linked")).toThrow(
        "bare primary worktree"
      )
    })

    it("fails when Git cannot identify a primary worktree", () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce("true\n")
        .mockReturnValueOnce("false\n")
        .mockReturnValueOnce("/path/to/worktree-feature\n")
        .mockReturnValueOnce("/path/to/main/.git\n")
        .mockReturnValueOnce("")

      expect(() => getRepositoryContext(testRepoPath)).toThrow(
        "Unable to resolve the main Git worktree"
      )
    })
  })

  describe("getGitRoot", () => {
    it("should return repository root path", () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce("true\n") // isGitRepository check
        .mockReturnValueOnce("/path/to/repo\n") // git rev-parse --show-toplevel

      const root = getGitRoot(testRepoPath)

      expect(root).toBe("/path/to/repo")
      expect(execFileSync).toHaveBeenCalledWith(
        "git",
        ["rev-parse", "--show-toplevel"],
        expect.objectContaining({ cwd: testRepoPath })
      )
    })

    it("should throw error when not in git repository", () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error("Not a git repository")
      })

      expect(() => getGitRoot("/tmp/not-git")).toThrow("Not in a Git repository")
    })
  })

  describe("getMainWorktreeRoot", () => {
    it("returns the MAIN repo root from inside a linked worktree", () => {
      // linked worktree 内でも --git-common-dir は main の .git を指す。
      vi.mocked(execFileSync)
        .mockReturnValueOnce("true\n") // inside worktree
        .mockReturnValueOnce("false\n") // not bare
        .mockReturnValueOnce("/path/to/worktree-feature\n") // current root
        .mockReturnValueOnce("/path/to/main/.git\n") // common Git directory
        .mockReturnValueOnce("worktree /path/to/main\0HEAD abc\0\0")

      const root = getMainWorktreeRoot("/path/to/worktree-feature")

      expect(root).toBe("/path/to/main")
      expect(execFileSync).toHaveBeenCalledWith(
        "git",
        ["rev-parse", "--git-common-dir"],
        expect.objectContaining({ cwd: "/path/to/worktree-feature" })
      )
    })

    it("resolves a relative common dir against cwd (main worktree returns '.git')", () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce("true\n") // inside worktree
        .mockReturnValueOnce("false\n") // not bare
        .mockReturnValueOnce("/path/to/main\n") // current root
        .mockReturnValueOnce(".git\n") // main worktree では相対で返るバージョンがある
        .mockReturnValueOnce("worktree /path/to/main\0HEAD abc\0\0")

      const root = getMainWorktreeRoot("/path/to/main")

      expect(root).toBe("/path/to/main")
    })

    it("throws CLIError when not in a git repository", () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error("Not a git repository")
      })

      expect(() => getMainWorktreeRoot("/tmp/not-git")).toThrow("Not in a git repository")
    })
  })

  describe("repository lock", () => {
    it("creates owner metadata and releases only its own lock", async () => {
      const commonGitDir = await createTemporaryCommonGitDir()
      const lockDirectory = path.join(commonGitDir, REPOSITORY_LOCK_DIR_NAME)

      const release = await acquireRepositoryLock(commonGitDir)
      const owner = JSON.parse(
        await readFile(path.join(lockDirectory, REPOSITORY_LOCK_OWNER_FILE), "utf8")
      ) as { pid: number; startedAt: number; token: string }

      expect(owner.pid).toBe(process.pid)
      expect(owner.startedAt).toBeTypeOf("number")
      expect(owner.token).toBeTypeOf("string")

      await release()
      await release() // idempotent
      await expect(stat(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("times out without removing an active owner's lock", async () => {
      const commonGitDir = await createTemporaryCommonGitDir()
      const release = await acquireRepositoryLock(commonGitDir)

      await expect(
        acquireRepositoryLock(commonGitDir, { waitTimeoutMs: 10, pollIntervalMs: 2 })
      ).rejects.toThrow("Timed out after 10ms waiting for repository lock")

      const owner = JSON.parse(
        await readFile(
          path.join(commonGitDir, REPOSITORY_LOCK_DIR_NAME, REPOSITORY_LOCK_OWNER_FILE),
          "utf8"
        )
      ) as { pid: number }
      expect(owner.pid).toBe(process.pid)
      await release()
    })

    it("reclaims a lock only when its owner is dead and older than ten minutes", async () => {
      const commonGitDir = await createTemporaryCommonGitDir()
      const lockDirectory = path.join(commonGitDir, REPOSITORY_LOCK_DIR_NAME)
      const deadPid = 987_654_321
      await mkdir(lockDirectory)
      await writeFile(
        path.join(lockDirectory, REPOSITORY_LOCK_OWNER_FILE),
        JSON.stringify({
          pid: deadPid,
          startedAt: Date.now() - REPOSITORY_LOCK_STALE_MS - 1_000,
          token: "dead-owner",
        })
      )
      const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
        if (pid === deadPid) {
          throw Object.assign(new Error("process not found"), { code: "ESRCH" })
        }
        return true
      }) as typeof process.kill)

      try {
        const release = await acquireRepositoryLock(commonGitDir, { waitTimeoutMs: 0 })
        const replacement = JSON.parse(
          await readFile(path.join(lockDirectory, REPOSITORY_LOCK_OWNER_FILE), "utf8")
        ) as { pid: number; token: string }
        expect(replacement.pid).toBe(process.pid)
        expect(replacement.token).not.toBe("dead-owner")
        await release()
      } finally {
        kill.mockRestore()
      }
    })

    it("does not reclaim a dead owner's lock before ten minutes", async () => {
      const commonGitDir = await createTemporaryCommonGitDir()
      const lockDirectory = path.join(commonGitDir, REPOSITORY_LOCK_DIR_NAME)
      const deadPid = 987_654_322
      const originalOwner = {
        pid: deadPid,
        startedAt: Date.now() - REPOSITORY_LOCK_STALE_MS + 60_000,
        token: "young-dead-owner",
      }
      await mkdir(lockDirectory)
      await writeFile(
        path.join(lockDirectory, REPOSITORY_LOCK_OWNER_FILE),
        JSON.stringify(originalOwner)
      )
      const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
        if (pid === deadPid) {
          throw Object.assign(new Error("process not found"), { code: "ESRCH" })
        }
        return true
      }) as typeof process.kill)

      try {
        await expect(
          acquireRepositoryLock(commonGitDir, { waitTimeoutMs: 0 })
        ).rejects.toThrow("Timed out after 0ms waiting for repository lock")
        expect(
          JSON.parse(
            await readFile(path.join(lockDirectory, REPOSITORY_LOCK_OWNER_FILE), "utf8")
          )
        ).toEqual(originalOwner)
      } finally {
        kill.mockRestore()
      }
    })

    it("fails closed for corrupt owner metadata", async () => {
      const commonGitDir = await createTemporaryCommonGitDir()
      const lockDirectory = path.join(commonGitDir, REPOSITORY_LOCK_DIR_NAME)
      await mkdir(lockDirectory)
      await writeFile(path.join(lockDirectory, REPOSITORY_LOCK_OWNER_FILE), "not-json")

      await expect(
        acquireRepositoryLock(commonGitDir, { waitTimeoutMs: 0 })
      ).rejects.toThrow("Timed out after 0ms waiting for repository lock")
      expect(await readFile(path.join(lockDirectory, REPOSITORY_LOCK_OWNER_FILE), "utf8")).toBe(
        "not-json"
      )
    })

    it("releases the lock when the protected operation throws", async () => {
      const commonGitDir = await createTemporaryCommonGitDir()
      const lockDirectory = path.join(commonGitDir, REPOSITORY_LOCK_DIR_NAME)

      await expect(
        withRepositoryLock(commonGitDir, async () => {
          throw new Error("setup failed")
        })
      ).rejects.toThrow("setup failed")

      await expect(stat(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" })
    })
  })

  describe("getCurrentBranch", () => {
    it("should return current branch name", () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce("true\n") // isGitRepository check
        .mockReturnValueOnce("main\n") // git branch --show-current

      const branch = getCurrentBranch(testRepoPath)

      expect(branch).toBe("main")
      expect(execFileSync).toHaveBeenCalledWith(
        "git",
        ["branch", "--show-current"],
        expect.objectContaining({ cwd: testRepoPath })
      )
    })
  })

  describe("branchExists", () => {
    it("should return true when branch exists", () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce("true\n") // isGitRepository check
        .mockReturnValueOnce("") // git show-ref (success = branch exists)

      const exists = branchExists("feature-branch", testRepoPath)

      expect(exists).toBe(true)
      expect(execFileSync).toHaveBeenCalledWith(
        "git",
        ["show-ref", "--verify", "--quiet", "refs/heads/feature-branch"],
        expect.objectContaining({ cwd: testRepoPath })
      )
    })

    it("should return false when branch does not exist", () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce("true\n") // isGitRepository check
        .mockImplementationOnce(() => {
          throw new Error("Branch not found")
        })

      const exists = branchExists("nonexistent-branch", testRepoPath)

      expect(exists).toBe(false)
    })
  })

  describe("remoteBranchExists", () => {
    it("should return true when the branch exists on origin", () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce("true\n") // isGitRepository check
        .mockReturnValueOnce("") // git show-ref (success = remote branch exists)

      const exists = remoteBranchExists("feature-branch", "origin", testRepoPath)

      expect(exists).toBe(true)
      expect(execFileSync).toHaveBeenCalledWith(
        "git",
        ["show-ref", "--verify", "--quiet", "refs/remotes/origin/feature-branch"],
        expect.objectContaining({ cwd: testRepoPath })
      )
    })

    it("should return false when the branch does not exist on the remote", () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce("true\n") // isGitRepository check
        .mockImplementationOnce(() => {
          throw new Error("Remote branch not found")
        })

      const exists = remoteBranchExists("nonexistent-branch", "origin", testRepoPath)

      expect(exists).toBe(false)
    })

    it("defaults the remote to origin", () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce("true\n") // isGitRepository check
        .mockReturnValueOnce("") // git show-ref

      remoteBranchExists("feature-branch")

      expect(execFileSync).toHaveBeenCalledWith(
        "git",
        ["show-ref", "--verify", "--quiet", "refs/remotes/origin/feature-branch"],
        expect.anything()
      )
    })
  })

  describe("revisionExists", () => {
    it("verifies the revision via rev-parse --verify <rev>^{commit} (accepts tags/SHAs, not just refs/heads/)", () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce("true\n") // isGitRepository check
        .mockReturnValueOnce("abc123\n") // git rev-parse --verify

      const exists = revisionExists("v1.0.0", testRepoPath)

      expect(exists).toBe(true)
      expect(execFileSync).toHaveBeenCalledWith(
        "git",
        ["rev-parse", "--verify", "--quiet", "--end-of-options", "v1.0.0^{commit}"],
        expect.objectContaining({ cwd: testRepoPath })
      )
    })

    it("should return false when the revision does not resolve", () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce("true\n") // isGitRepository check
        .mockImplementationOnce(() => {
          throw new Error("fatal: Needed a single revision")
        })

      const exists = revisionExists("main", testRepoPath)

      expect(exists).toBe(false)
    })

    it("should return false outside a git repository", () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error("Not a git repository")
      })

      expect(revisionExists("main", "/tmp/not-git")).toBe(false)
    })
  })

  describe("getRepositoryInfo", () => {
    it("should return complete repository information", () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce("true\n") // isGitRepository check (from getRepositoryInfo)
        .mockReturnValueOnce("true\n") // isGitRepository check (from getGitRoot)
        .mockReturnValueOnce("/path/to/repo\n") // getGitRoot
        .mockReturnValueOnce("true\n") // isGitRepository check (from getCurrentBranch)
        .mockReturnValueOnce("main\n") // getCurrentBranch
        .mockReturnValueOnce("") // git status --porcelain (clean repo)

      const info = getRepositoryInfo(testRepoPath)

      expect(info.root).toBe("/path/to/repo")
      expect(info.currentBranch).toBe("main")
      expect(info.isClean).toBe(true)
      expect(info.isGitRepository).toBe(true)
    })

    it("should detect dirty repository", () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce("true\n") // isGitRepository check (from getRepositoryInfo)
        .mockReturnValueOnce("true\n") // isGitRepository check (from getGitRoot)
        .mockReturnValueOnce("/path/to/repo\n") // getGitRoot
        .mockReturnValueOnce("true\n") // isGitRepository check (from getCurrentBranch)
        .mockReturnValueOnce("main\n") // getCurrentBranch
        .mockReturnValueOnce("M file.txt\n") // git status --porcelain (dirty)

      const info = getRepositoryInfo(testRepoPath)

      expect(info.isClean).toBe(false)
    })
  })
})
