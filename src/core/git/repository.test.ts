/**
 * @fileoverview Git リポジトリ操作のテスト
 * 新しいディレクトリ構造に対応したテストファイル
 */

import { execFileSync } from "node:child_process"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  branchExists,
  getCurrentBranch,
  getGitRoot,
  getRepositoryInfo,
  isGitRepository,
  remoteBranchExists,
  revisionExists,
} from "./repository.js"

// Mock dependencies
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}))

describe("Git Repository Operations (Refactored)", () => {
  const testRepoPath = "/tmp/test-repo"

  beforeEach(() => {
    vi.clearAllMocks()
  })

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
