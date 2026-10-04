import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parse } from "yaml"
import { installOrcaHooks, mergeOrcaConfiguration, resolveOrcaRoot } from "./orca-install.js"

describe("Orca hook installation", () => {
  let directory: string
  let repo: string
  let file: string
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" })

  beforeEach(() => {
    directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wtb orca ")))
    repo = path.join(directory, "main")
    mkdirSync(repo)
    git("init", "-q")
    git("config", "user.name", "test")
    git("config", "user.email", "test@example.com")
    git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "init")
    file = path.join(repo, "orca.yaml")
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it("installs exact hooks and leaves an unchanged file untouched on repeated installation", async () => {
    const first = await installOrcaHooks({ removeVolumes: true }, repo, repo)
    const content = readFileSync(file, "utf8")
    expect(first).toMatchObject({ wrote: true, ok: true })
    expect(parse(content)).toEqual({
      scripts: {
        setup: "wtb setup --up --wait --timeout 120 --json",
        archive: "wtb teardown --remove-volumes --json",
      },
      setupAgentStartupPolicy: "wait-for-setup",
    })
    const second = await installOrcaHooks({ removeVolumes: true }, repo, repo)
    expect(second).toMatchObject({ wrote: false, changed: false, differences: [] })
    expect(readFileSync(file, "utf8")).toBe(content)
  })

  it("preserves unrelated keys, comments, and file mode", async () => {
    writeFileSync(
      file,
      "# Project defaults\ndefaultTabs:\n  - title: Dev # keep me\n    command: npm run dev\nscripts:\n  custom: echo retained # custom\n"
    )
    chmodSync(file, 0o640)
    await installOrcaHooks({}, repo, repo)
    const content = readFileSync(file, "utf8")
    expect(content).toContain("# Project defaults")
    expect(content).toContain("title: Dev # keep me")
    expect(content).toContain("custom: echo retained # custom")
    expect(parse(content).scripts.archive).toBe("wtb teardown --json")
    expect(statSync(file).mode & 0o777).toBe(0o640)
  })

  it("refuses existing hooks and replaces only integration keys with force", async () => {
    const original =
      "scripts:\n  setup: npm ci # setup note\n  archive: echo keep\n  custom: echo untouched\nsetupAgentStartupPolicy: start-immediately\nissueCommand: issue --open\n"
    writeFileSync(file, original)
    await expect(installOrcaHooks({}, repo, repo)).rejects.toThrow(/conflicts/)
    expect(readFileSync(file, "utf8")).toBe(original)
    await installOrcaHooks({ force: true }, repo, repo)
    const content = readFileSync(file, "utf8")
    expect(content).toContain("# setup note")
    expect(parse(content)).toMatchObject({
      scripts: { custom: "echo untouched" },
      issueCommand: "issue --open",
    })
  })

  it("check detects missing or different volume policy and writes nothing", async () => {
    expect(await installOrcaHooks({ check: true }, repo, repo)).toMatchObject({
      ok: false,
      wrote: false,
    })
    expect(existsSync(file)).toBe(false)
    await installOrcaHooks({}, repo, repo)
    const original = readFileSync(file, "utf8")
    expect(await installOrcaHooks({ check: true }, repo, repo)).toMatchObject({ ok: true })
    expect(await installOrcaHooks({ check: true, removeVolumes: true }, repo, repo)).toMatchObject({
      ok: false,
      differences: ["scripts.archive"],
    })
    expect(readFileSync(file, "utf8")).toBe(original)
  })

  it("dry-run creates neither config nor repository lock artifacts", async () => {
    expect(await installOrcaHooks({ dryRun: true }, repo, repo)).toMatchObject({
      wrote: false,
      changed: true,
    })
    expect(existsSync(file)).toBe(false)
  })

  it("targets the canonical main root by default and accepts an explicitly registered linked root", async () => {
    const linked = path.join(directory, "Orca checkout")
    git("worktree", "add", "-qb", "feature", linked)
    expect(resolveOrcaRoot(linked)).toBe(repo)
    expect(resolveOrcaRoot(linked, linked)).toBe(linked)
    await installOrcaHooks({}, linked, linked)
    expect(existsSync(path.join(linked, "orca.yaml"))).toBe(true)
    expect(existsSync(file)).toBe(false)
  })

  it("rejects another repository, a subdirectory, and relative ORCA_ROOT_PATH", async () => {
    const other = path.join(directory, "other")
    mkdirSync(other)
    execFileSync("git", ["init", "-q"], { cwd: other })
    mkdirSync(path.join(repo, "nested"))
    expect(() => resolveOrcaRoot(repo, other)).toThrow(/this Git repository/)
    expect(() => resolveOrcaRoot(repo, path.join(repo, "nested"))).toThrow(/worktree root/)
    expect(() => resolveOrcaRoot(repo, ".")).toThrow(/absolute/)
    expect(existsSync(path.join(other, "orca.yaml"))).toBe(false)
  })

  it("refuses a config symlink even with force", async () => {
    const external = path.join(directory, "external.yaml")
    writeFileSync(external, "scripts: {}\n")
    symlinkSync(external, file)
    await expect(installOrcaHooks({ force: true }, repo, repo)).rejects.toThrow(/symlinked/)
    expect(readFileSync(external, "utf8")).toBe("scripts: {}\n")
  })

  it.each([
    "scripts: &hooks {setup: npm ci}\nother: *hooks\n",
    "scripts:\n  setup: &setup npm ci\nother: *setup\n",
  ])("does not change unrelated settings through shared anchors", (content) => {
    expect(() => mergeOrcaConfiguration(content, { force: true })).toThrow(/anchored/)
  })

  it.each([
    "scripts: [broken",
    "- list",
    "scripts: hi",
    "scripts: {}\nscripts: {}",
    "shared: &hooks {}\nscripts: *hooks",
  ])("refuses malformed or ambiguous YAML: %s", (content) => {
    expect(() => mergeOrcaConfiguration(content, { force: true })).toThrow(/mapping/)
  })
})
