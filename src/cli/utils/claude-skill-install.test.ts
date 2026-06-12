import { execSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { APP_VERSION } from "../../constants/index.js"
import {
  checkClaudeSkill,
  installClaudeSkill,
  parseSkillVersion,
  resolveTargetDir,
  stampSkillContent,
} from "./claude-skill-install.js"

function mkTempRepo(): string {
  // macOS returns /private/var/... via git rev-parse --show-toplevel, resolve upfront
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wtb-skill-test-")))
  execSync("git init -q", { cwd: dir })
  execSync('git config user.email "t@t.t"', { cwd: dir })
  execSync('git config user.name "t"', { cwd: dir })
  // 初期コミットを作って gitRoot を安定させる
  writeFileSync(path.join(dir, "README.md"), "x", "utf-8")
  execSync("git add README.md && git commit -q -m init", { cwd: dir })
  return dir
}

describe("resolveTargetDir", () => {
  it("returns ~/.claude/skills/wtb when --user", () => {
    const target = resolveTargetDir({ user: true })
    expect(target).toBe(path.join(os.homedir(), ".claude", "skills", "wtb"))
  })

  it("returns <gitRoot>/.claude/skills/wtb when repo", () => {
    const repo = mkTempRepo()
    try {
      const target = resolveTargetDir({}, repo)
      expect(target).toBe(path.join(repo, ".claude", "skills", "wtb"))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it("throws when not a git repo and --user is not set", () => {
    const nonRepo = mkdtempSync(path.join(os.tmpdir(), "wtb-not-repo-"))
    try {
      expect(() => resolveTargetDir({}, nonRepo)).toThrow(/Not in a git repository/)
    } finally {
      rmSync(nonRepo, { recursive: true, force: true })
    }
  })
})

describe("installClaudeSkill", () => {
  let repo: string
  const origCwd = process.cwd()

  beforeEach(() => {
    repo = mkTempRepo()
    process.chdir(repo)
  })

  afterEach(() => {
    process.chdir(origCwd)
    rmSync(repo, { recursive: true, force: true })
  })

  it("writes SKILL.md to the repo .claude/skills/wtb/", async () => {
    const result = await installClaudeSkill({})
    expect(result.wrote).toBe(true)
    expect(result.existed).toBe(false)
    expect(existsSync(result.skillPath)).toBe(true)
    const content = readFileSync(result.skillPath, "utf-8")
    expect(content).toMatch(/^---\nname: wtb\b/m)
  })

  it("stamps the installed SKILL.md with the CLI version right after the frontmatter", async () => {
    const result = await installClaudeSkill({})
    const content = readFileSync(result.skillPath, "utf-8")
    // frontmatter 直後 (2 つ目の `---` の次の行) に stamp が入る
    expect(content).toMatch(
      new RegExp(`\\n---\\n<!-- wtb-skill-version: ${APP_VERSION.replace(/\./g, "\\.")} -->\\n`)
    )
    expect(parseSkillVersion(content)).toBe(APP_VERSION)
  })

  it("skips with 'already exists' when the installed version matches the CLI", async () => {
    await installClaudeSkill({})
    const second = await installClaudeSkill({})
    expect(second.wrote).toBe(false)
    expect(second.existed).toBe(true)
    expect(second.skippedReason).toMatch(/already exists/)
  })

  it("reports stale on the skip path when the installed version differs", async () => {
    const first = await installClaudeSkill({})
    const stale = readFileSync(first.skillPath, "utf-8").replace(
      /<!-- wtb-skill-version: \S+ -->/,
      "<!-- wtb-skill-version: 0.0.1 -->"
    )
    writeFileSync(first.skillPath, stale, "utf-8")

    const second = await installClaudeSkill({})
    expect(second.wrote).toBe(false)
    expect(second.skippedReason).toBe(
      `stale (installed v0.0.1, bundled v${APP_VERSION}) — re-run with --force`
    )
  })

  it("treats an unstamped (pre-stamp) install as stale on the skip path", async () => {
    const first = await installClaudeSkill({})
    writeFileSync(first.skillPath, "---\nname: wtb\n---\nno stamp here\n", "utf-8")

    const second = await installClaudeSkill({})
    expect(second.wrote).toBe(false)
    expect(second.skippedReason).toBe(
      `stale (installed unstamped, bundled v${APP_VERSION}) — re-run with --force`
    )
  })

  it("overwrites with --force", async () => {
    const first = await installClaudeSkill({})
    writeFileSync(first.skillPath, "stale content", "utf-8")
    const second = await installClaudeSkill({ force: true })
    expect(second.wrote).toBe(true)
    const content = readFileSync(second.skillPath, "utf-8")
    expect(content).not.toBe("stale content")
    expect(content).toMatch(/name: wtb/)
  })

  it("does not write when --dry-run", async () => {
    const result = await installClaudeSkill({ dryRun: true })
    expect(result.wrote).toBe(false)
    expect(existsSync(result.skillPath)).toBe(false)
  })

  it("refuses to overwrite a symlink at the target", async () => {
    const targetDir = path.join(repo, ".claude", "skills", "wtb")
    execSync(`mkdir -p ${targetDir}`)
    const symlinkTarget = path.join(repo, "external-target.md")
    writeFileSync(symlinkTarget, "evil", "utf-8")
    symlinkSync(symlinkTarget, path.join(targetDir, "SKILL.md"))
    await expect(installClaudeSkill({ force: true })).rejects.toThrow(/symlink/)
  })
})

describe("stampSkillContent / parseSkillVersion", () => {
  it("injects the stamp right after the frontmatter block", () => {
    const stamped = stampSkillContent("---\nname: wtb\n---\nbody\n", "1.2.3")
    expect(stamped).toBe("---\nname: wtb\n---\n<!-- wtb-skill-version: 1.2.3 -->\nbody\n")
  })

  it("prepends the stamp when there is no frontmatter", () => {
    const stamped = stampSkillContent("body only\n", "1.2.3")
    expect(stamped).toBe("<!-- wtb-skill-version: 1.2.3 -->\nbody only\n")
  })

  it("round-trips through parseSkillVersion", () => {
    expect(parseSkillVersion(stampSkillContent("---\nname: wtb\n---\nx\n", "9.9.9"))).toBe("9.9.9")
  })

  it("returns null for unstamped content", () => {
    expect(parseSkillVersion("---\nname: wtb\n---\nno stamp\n")).toBeNull()
  })
})

describe("checkClaudeSkill", () => {
  let repo: string
  const origCwd = process.cwd()

  beforeEach(() => {
    repo = mkTempRepo()
    process.chdir(repo)
  })

  afterEach(() => {
    process.chdir(origCwd)
    rmSync(repo, { recursive: true, force: true })
  })

  it("reports not installed (stale) when SKILL.md is absent", () => {
    const result = checkClaudeSkill({})
    expect(result.installed).toBe(false)
    expect(result.installedVersion).toBeNull()
    expect(result.stale).toBe(true)
  })

  it("reports up to date right after install", async () => {
    await installClaudeSkill({})
    const result = checkClaudeSkill({})
    expect(result.installed).toBe(true)
    expect(result.installedVersion).toBe(APP_VERSION)
    expect(result.bundledVersion).toBe(APP_VERSION)
    expect(result.stale).toBe(false)
  })

  it("reports stale when the installed stamp is an older version", async () => {
    const installed = await installClaudeSkill({})
    const old = readFileSync(installed.skillPath, "utf-8").replace(
      /<!-- wtb-skill-version: \S+ -->/,
      "<!-- wtb-skill-version: 0.0.1 -->"
    )
    writeFileSync(installed.skillPath, old, "utf-8")

    const result = checkClaudeSkill({})
    expect(result.installed).toBe(true)
    expect(result.installedVersion).toBe("0.0.1")
    expect(result.stale).toBe(true)
  })

  it("treats an unstamped install as stale", async () => {
    const installed = await installClaudeSkill({})
    writeFileSync(installed.skillPath, "---\nname: wtb\n---\nno stamp\n", "utf-8")

    const result = checkClaudeSkill({})
    expect(result.installed).toBe(true)
    expect(result.installedVersion).toBeNull()
    expect(result.stale).toBe(true)
  })
})
