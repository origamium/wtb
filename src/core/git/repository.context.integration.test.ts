import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT_CODES } from "../../constants/index.js"
import { CLIError } from "../../utils/error.js"
import { getRepositoryContext } from "./repository.js"

describe("getRepositoryContext with real Git worktrees", () => {
  let testDirectory: string

  beforeEach(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), "wtb-repository-context-"))
  })

  afterEach(async () => {
    await rm(testDirectory, { recursive: true, force: true })
  })

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim()
  }

  async function createRepository(): Promise<string> {
    const repository = path.join(testDirectory, "main")
    await mkdir(repository)
    git(repository, ["init", "--initial-branch=main"])
    git(repository, ["config", "user.name", "WTB Test"])
    git(repository, ["config", "user.email", "wtb-test@example.invalid"])
    await writeFile(path.join(repository, "README.md"), "test\n")
    git(repository, ["add", "README.md"])
    git(repository, ["commit", "-m", "initial"])
    return repository
  }

  it("returns the same main and common paths from main and linked worktrees", async () => {
    const mainRoot = await createRepository()
    const linkedRoot = path.join(testDirectory, "feature")
    git(mainRoot, ["worktree", "add", "-b", "feature/context", linkedRoot])
    const nestedDirectory = path.join(linkedRoot, "src", "nested")
    await mkdir(nestedDirectory, { recursive: true })

    const expectedMain = await realpath(mainRoot)
    const expectedLinked = await realpath(linkedRoot)
    const expectedCommon = await realpath(path.join(mainRoot, ".git"))

    expect(getRepositoryContext(mainRoot)).toEqual({
      currentRoot: expectedMain,
      mainRoot: expectedMain,
      commonGitDir: expectedCommon,
    })
    expect(getRepositoryContext(nestedDirectory)).toEqual({
      currentRoot: expectedLinked,
      mainRoot: expectedMain,
      commonGitDir: expectedCommon,
    })
  })

  it("rejects a bare repository", async () => {
    const bareRepository = path.join(testDirectory, "bare.git")
    await mkdir(bareRepository)
    git(bareRepository, ["init", "--bare"])

    try {
      getRepositoryContext(bareRepository)
      throw new Error("Expected getRepositoryContext to reject a bare repository")
    } catch (error) {
      expect(error).toBeInstanceOf(CLIError)
      expect((error as CLIError).exitCode).toBe(EXIT_CODES.NOT_GIT_REPOSITORY)
    }
  })

  it("rejects a linked checkout when the primary repository is bare", async () => {
    const source = await createRepository()
    const bareRepository = path.join(testDirectory, "primary.git")
    execFileSync("git", ["clone", "--bare", source, bareRepository], {
      encoding: "utf8",
      stdio: "pipe",
    })
    const linkedRoot = path.join(testDirectory, "linked-from-bare")
    execFileSync("git", ["--git-dir", bareRepository, "worktree", "add", linkedRoot, "main"], {
      encoding: "utf8",
      stdio: "pipe",
    })

    expect(() => getRepositoryContext(linkedRoot)).toThrow("bare primary worktree")
  })
})
