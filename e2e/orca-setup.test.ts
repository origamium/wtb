import { execFile, execFileSync, spawnSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { stringify } from "yaml"

const cli = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url))
const tempRoots: string[] = []
const execFileAsync = promisify(execFile)
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim()
}
function fixture(start = "printf started >> started.log", compose = false) {
  const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), "wtb-orca-")))
  tempRoots.push(temporary)
  const main = path.join(temporary, "source repo")
  mkdirSync(main)
  git(main, "init", "-b", "main")
  git(main, "config", "user.email", "wtb-test@example.invalid")
  git(main, "config", "user.name", "wtb test")
  writeFileSync(path.join(main, ".gitignore"), ".env\nnode_modules/\nlocal.txt\nstarted.log\n")
  writeFileSync(path.join(main, "wtb.yaml"), stringify({ base_branch: "main", docker_compose_file: compose ? "compose.yaml" : "",
    copy_files: ["local.txt", "missing.txt"], link_files: ["node_modules"],
    env: { file: [".env"], adjust: { APP_PORT: 1 } }, start_command: start }))
  if (compose) writeFileSync(path.join(main, "compose.yaml"), "services: {}\nvolumes:\n  main_only: {}\n")
  writeFileSync(path.join(main, "tracked.txt"), "original\n")
  git(main, "add", ".")
  git(main, "commit", "-m", "fixture")
  writeFileSync(path.join(main, ".env"), "APP_PORT=3000\nSECRET=not-exported\n")
  writeFileSync(path.join(main, "local.txt"), "source local config\n")
  mkdirSync(path.join(main, "node_modules"))
  writeFileSync(path.join(main, "node_modules", "dependency"), "shared")
  const bin = path.join(temporary, "bin")
  mkdirSync(bin)
  const dockerMarker = path.join(temporary, "docker-called")
  writeFileSync(path.join(bin, "docker"), '#!/bin/sh\nprintf called >> "$DOCKER_MARKER"\nexit 99\n')
  chmodSync(path.join(bin, "docker"), 0o755)
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, DOCKER_MARKER: dockerMarker }
  delete env.ORCA_WORKTREE_PATH
  delete env.ORCA_ROOT_PATH
  delete env.COMPOSE_FILE
  delete env.COMPOSE_PROJECT_NAME
  function worktree(branch = "feature/one") {
    const target = path.join(temporary, branch.replaceAll("/", " "))
    git(main, "worktree", "add", "-b", branch, target)
    return target
  }
  function run(cwd: string, ...args: string[]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" })
    return { code: result.status, stdout: result.stdout, stderr: result.stderr }
  }
  return { main, worktree, run, env, dockerMarker, temporary }
}
afterEach(() => { for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("Orca-style existing worktree setup", () => {
  it("prepares a fresh checkout without Docker, starts once and reuses unchanged ports/files", () => {
    const f = fixture()
    const target = f.worktree()
    const first = f.run(target, "setup", "--up", "--wait", "--json")
    expect(first.code, first.stderr).toBe(0)
    expect(JSON.parse(first.stdout)).toMatchObject({ ok: true, prepared: true, reused: false, path: target })
    expect(readFileSync(path.join(target, ".env"), "utf8")).toContain("APP_PORT=3001")
    expect(readFileSync(path.join(target, "local.txt"), "utf8")).toBe("source local config\n")
    expect(lstatSync(path.join(target, "node_modules")).isSymbolicLink()).toBe(true)
    const second = f.run(target, "setup", "--up", "--wait", "--json")
    expect(second.code, second.stderr).toBe(0)
    expect(JSON.parse(second.stdout)).toMatchObject({ ok: true, reused: true })
    expect(readFileSync(path.join(target, "started.log"), "utf8")).toBe("started")
    expect(readFileSync(path.join(target, ".env"), "utf8")).toContain("APP_PORT=3001")
    expect(existsSync(f.dockerMarker)).toBe(false)
  })
  it("allocates distinct ports when two external worktrees are set up concurrently", async () => {
    const f = fixture()
    const one = f.worktree("one"), two = f.worktree("two")
    const results = await Promise.all([one, two].map(cwd => execFileAsync(process.execPath, [cli, "setup", "--json"], { cwd, env: f.env })))
    expect(results.every(result => JSON.parse(result.stdout).ok)).toBe(true)
    const ports = [one, two].map(target => /APP_PORT=(\d+)/.exec(readFileSync(path.join(target, ".env"), "utf8"))?.[1])
    expect(new Set(ports).size).toBe(2)
    expect(ports).not.toContain("3000")
  })
  it("refuses main, hand-created target data, and later managed-file edits without overwriting", () => {
    const f = fixture()
    expect(f.run(f.main, "setup", "--json").code).toBe(1)
    const target = f.worktree()
    writeFileSync(path.join(target, "local.txt"), "my work")
    const blocked = f.run(target, "setup", "--json")
    expect(blocked.code).toBe(1)
    expect(JSON.parse(blocked.stdout).error).toContain("unmanaged or edited")
    expect(readFileSync(path.join(target, "local.txt"), "utf8")).toBe("my work")
    expect(existsSync(path.join(target, ".env"))).toBe(false)
    const fresh = f.worktree("fresh")
    expect(f.run(fresh, "setup", "--json").code).toBe(0)
    writeFileSync(path.join(fresh, ".env"), "APP_PORT=9999\n")
    const rerun = f.run(fresh, "setup", "--json")
    expect(rerun.code).toBe(1)
    expect(JSON.parse(rerun.stdout).error).toContain("Setup artifact changed")
    expect(readFileSync(path.join(fresh, ".env"), "utf8")).toBe("APP_PORT=9999\n")
  })
  it("records failed start and refuses replay, preserving phase diagnostics and user work", () => {
    const f = fixture("printf attempted >> started.log; exit 17")
    const target = f.worktree()
    const first = f.run(target, "setup", "--json")
    expect(first.code).toBe(1)
    expect(JSON.parse(first.stdout)).toMatchObject({ ok: false, setup: { startCommandFailed: true } })
    const stateFile = git(target, "rev-parse", "--git-path", "wtb-setup.json")
    expect(JSON.parse(readFileSync(path.resolve(target, stateFile), "utf8"))).toMatchObject({ status: "failed", phase: "start" })
    const second = f.run(target, "setup", "--json")
    expect(second.code).toBe(1)
    expect(JSON.parse(second.stdout).error).toContain("Setup state is failed")
    expect(readFileSync(path.join(target, "started.log"), "utf8")).toBe("attempted")
  })
  it("dry-run inspects missing sources without files, index flags, Docker or setup records", () => {
    const f = fixture(), target = f.worktree()
    const before = git(target, "status", "--porcelain")
    const run = f.run(target, "setup", "--dry-run", "--json")
    expect(run.code, run.stderr).toBe(0)
    expect(run.stderr).toContain("Missing source: missing.txt (would skip copy)")
    expect(existsSync(path.join(target, ".env"))).toBe(false)
    expect(existsSync(path.resolve(target, git(target, "rev-parse", "--git-path", "wtb-setup.json")))).toBe(false)
    expect(git(target, "status", "--porcelain")).toBe(before)
    expect(existsSync(f.dockerMarker)).toBe(false)
  })
  it("teardown leaves the checkout and makes prior setup non-reusable", () => {
    const f = fixture(), target = f.worktree()
    expect(f.run(target, "setup", "--json").code).toBe(0)
    const cleanup = f.run(target, "teardown", "--remove-volumes", "--json")
    expect(cleanup.code, cleanup.stderr).toBe(0)
    expect(JSON.parse(cleanup.stdout).ok).toBe(true)
    expect(existsSync(path.join(target, "tracked.txt"))).toBe(true)
    expect(JSON.parse(f.run(target, "setup", "--json").stdout).error).toContain("torn-down")
  })
})

describe("README CLI contracts", () => {
  it("preserves a branch Compose file nested inside copy_files directories", () => {
    const f = fixture("")
    mkdirSync(path.join(f.main, "infra"))
    writeFileSync(path.join(f.main, "infra", "compose.yaml"), "services: {}\nvolumes: { main_only: {} }\n")
    writeFileSync(path.join(f.main, "infra", "settings.txt"), "source settings")
    writeFileSync(path.join(f.main, "wtb.yaml"), stringify({ base_branch: "main", docker_compose_file: "infra/compose.yaml", copy_files: ["infra"], env: { file: [], adjust: {} } }))
    git(f.main, "add", ".")
    git(f.main, "commit", "-m", "nested compose fixture")
    const target = f.worktree()
    const branchCompose = "services: {}\nvolumes: { branch_only: {} }\n"
    writeFileSync(path.join(target, "infra", "compose.yaml"), branchCompose)
    git(target, "add", "infra/compose.yaml")
    git(target, "commit", "-m", "branch definition")
    writeFileSync(path.join(f.main, "infra", "settings.txt"), "updated source settings")
    const result = f.run(target, "setup", "--no-docker", "--json")
    expect(result.code, result.stderr).toBe(0)
    expect(readFileSync(path.join(target, "infra", "compose.yaml"), "utf8")).toBe(branchCompose)
    expect(readFileSync(path.join(target, "infra", "settings.txt"), "utf8")).toBe("updated source settings")
  })

  it("keeps paths-only stdout empty on errors even when --json is also specified", () => {
    const f = fixture()
    for (const command of ["ls", "list"]) {
      const result = f.run(f.temporary, command, "-p", "--json")
      expect(result.code).toBe(3)
      expect(result.stdout).toBe("")
      const usage = f.run(f.main, command, "-p", "--json", "--bogus")
      expect(usage.code).toBe(2)
      expect(usage.stdout).toBe("")
    }
  })

  it("returns exactly one JSON document and documented exit codes for early failures", () => {
    const f = fixture(), target = f.worktree()
    const cases: Array<[string, string[], number]> = [
      [f.main, ["create", "feature/one", "--json"], 6],
      [f.main, ["create", "--json"], 2],
      [f.main, ["create", "oops", "--json", "--unknown"], 2],
      [f.main, ["up", "main", "--json"], 1],
      [f.main, ["reclone", "main", "--json"], 1],
      [f.temporary, ["create", "outside", "--json"], 3],
      [target, ["await", "--timeout", "0", "--json"], 2],
      [f.main, ["ports", "--unknown"], 2],
    ]
    for (const [cwd, args, code] of cases) {
      const result = f.run(cwd, ...args)
      expect(result.code, `${args.join(" ")}: ${result.stderr}`).toBe(code)
      expect(JSON.parse(result.stdout).ok, args.join(" ")).toBe(false)
    }
    writeFileSync(path.join(f.main, "wtb.yaml"), "base_branch: []\n")
    const invalid = f.run(f.main, "create", "new", "--json")
    expect(invalid.code).toBe(4)
    expect(JSON.parse(invalid.stdout).ok).toBe(false)
  })
  it("create and reclone previews use the target branch Compose volume definitions", () => {
    const f = fixture("", true)
    git(f.main, "checkout", "-b", "preview")
    writeFileSync(path.join(f.main, "compose.yaml"), "services: {}\nvolumes:\n  branch_only: {}\n")
    git(f.main, "add", "compose.yaml")
    git(f.main, "commit", "-m", "branch compose")
    git(f.main, "checkout", "main")
    const preview = f.run(f.main, "create", "preview", "--dry-run", "--json")
    expect(preview.code, preview.stderr).toBe(0)
    expect(preview.stderr).toContain("branch refs/heads/preview")
    expect(preview.stderr).toContain("branch_only")
    expect(preview.stderr).not.toContain("- main_only")
    const target = path.join(f.temporary, "existing preview")
    git(f.main, "worktree", "add", target, "preview")
    const reclone = f.run(target, "reclone", "--dry-run", "--json")
    expect(reclone.code, reclone.stderr).toBe(0)
    expect(reclone.stderr).toContain("branch_only")
    expect(reclone.stderr).not.toContain("- main_only")
    expect(existsSync(f.dockerMarker)).toBe(false)
  })
})
