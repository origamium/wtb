/**
 * @fileoverview execSafeSync のエラー整形のテスト
 * 失敗時に単一の "Command failed: <cmd>" prefix + 実 stderr を載せ、prefix を重複
 * させないこと、binary 不在 (ENOENT) でも情報を失わないことを検証する。
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { execDockerSafe, execGitSafe, execSafeSync, executeLifecycleCommand } from "./exec.js"

describe("execSafeSync error formatting", () => {
  it("returns trimmed stdout on success", () => {
    const out = execSafeSync("node", ["-e", "process.stdout.write('hello\\n')"])
    expect(out).toBe("hello")
  })

  it("can preserve leading whitespace for machine-readable output", () => {
    const out = execSafeSync("node", ["-e", "process.stdout.write(' M file.txt\\n')"], {
      preserveLeadingWhitespace: true,
    })
    expect(out).toBe(" M file.txt")
  })

  it("captures the command's stderr into the thrown error", () => {
    try {
      execSafeSync("node", ["-e", "process.stderr.write('boom-detail'); process.exit(3)"])
      expect.unreachable("should have thrown")
    } catch (error) {
      const msg = (error as Error).message
      expect(msg).toContain("Command failed: node")
      expect(msg).toContain("boom-detail")
      // the "Command failed:" prefix must appear exactly once (no doubling)
      expect(msg.match(/Command failed:/g)?.length).toBe(1)
    }
  })

  it("preserves spawn errors (e.g. ENOENT) when the binary is missing", () => {
    try {
      execSafeSync("definitely-not-a-real-binary-xyz", ["--version"])
      expect.unreachable("should have thrown")
    } catch (error) {
      const msg = (error as Error).message
      expect(msg).toContain("Command failed: definitely-not-a-real-binary-xyz")
      // the underlying spawn error detail must not be lost
      expect(msg).toMatch(/ENOENT|spawn/)
      expect(msg.match(/Command failed:/g)?.length).toBe(1)
    }
  })
})

describe("execSafeSync shell-injection safety", () => {
  it("passes argv literally — shell metacharacters are NOT expanded", () => {
    // The core safety claim: args go straight to execFileSync (no shell), so a value
    // full of shell metacharacters must come back verbatim, never executed.
    const evil = "$(echo PWNED); rm -rf /tmp/whatever; `whoami` && echo x | cat"
    const out = execSafeSync("node", ["-e", "process.stdout.write(process.argv[1])", evil])
    expect(out).toBe(evil)
    expect(out).not.toContain("PWNED-expanded")
  })

  it("does not invoke a shell for the command name", () => {
    // A "command" containing a pipe is treated as a literal (missing) binary, not a pipeline.
    expect(() => execSafeSync("echo hi | rm -rf x", [])).toThrow(/Command failed: echo hi \| rm/)
  })
})

describe("execGitSafe / execDockerSafe", () => {
  it("execGitSafe runs git with array args", () => {
    const out = execGitSafe(["--version"])
    expect(out).toMatch(/git version/)
  })

  it("execGitSafe surfaces git errors with a single prefix", () => {
    try {
      execGitSafe(["definitely-not-a-git-subcommand"])
      expect.unreachable("should have thrown")
    } catch (error) {
      const msg = (error as Error).message
      expect(msg).toContain("Command failed: git")
      expect(msg.match(/Command failed:/g)?.length).toBe(1)
    }
  })

  it("execDockerSafe targets the docker binary (throws via docker, not a shell)", () => {
    // Works whether or not Docker is installed: a bogus subcommand errors, and a missing
    // binary ENOENTs — both throw with the "docker" command in the message.
    expect(() => execDockerSafe(["not-a-real-docker-subcommand-xyz"])).toThrow(
      /Command failed: docker/
    )
  })
})

describe("executeLifecycleCommand", () => {
  it("runs a user command through /bin/sh with the given cwd (shell syntax allowed)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtb-exec-"))
    try {
      // Redirection is a shell feature — its working proves /bin/sh is used, with cwd applied.
      executeLifecycleCommand("echo lifecycle-ran > out.txt", dir)
      expect(fs.readFileSync(path.join(dir, "out.txt"), "utf-8").trim()).toBe("lifecycle-ran")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("throws when the command exits non-zero (caller decides fatality)", () => {
    expect(() => executeLifecycleCommand("exit 7", os.tmpdir())).toThrow()
  })
})
