/**
 * @fileoverview worktree-render のテスト
 */

import { describe, expect, it } from "vitest"
import type { EnrichedWorktreeInfo, WorktreeInfo } from "../../types/index.js"
import {
  renderDefault,
  renderJson,
  renderLong,
  renderPaths,
  resolveCurrentWorktreePath,
  visualWidth,
} from "./worktree-render.js"

describe("resolveCurrentWorktreePath", () => {
  const wts: WorktreeInfo[] = [
    { path: "/repo", branch: "main", head: "a" },
    { path: "/repo-feature", branch: "feature", head: "b" },
  ]

  it("returns the worktree root when cwd is exactly the root", () => {
    expect(resolveCurrentWorktreePath(wts, "/repo")).toBe("/repo")
    expect(resolveCurrentWorktreePath(wts, "/repo-feature")).toBe("/repo-feature")
  })

  it("resolves a SUBDIRECTORY of a worktree to that worktree root (the documented bug)", () => {
    expect(resolveCurrentWorktreePath(wts, "/repo-feature/src/components")).toBe("/repo-feature")
    expect(resolveCurrentWorktreePath(wts, "/repo/deep/nested/dir")).toBe("/repo")
  })

  it("does not let a path-prefix sibling match (/repo vs /repo-feature)", () => {
    // "/repo-feature/x" must resolve to /repo-feature, NOT /repo (prefix-but-not-subpath).
    expect(resolveCurrentWorktreePath(wts, "/repo-feature/x")).toBe("/repo-feature")
  })

  it("picks the most specific (longest) match for nested worktrees", () => {
    const nested: WorktreeInfo[] = [
      { path: "/repo", branch: "main", head: "a" },
      { path: "/repo/sub", branch: "sub", head: "b" },
    ]
    expect(resolveCurrentWorktreePath(nested, "/repo/sub/x")).toBe("/repo/sub")
  })

  it("returns the resolved cwd when no worktree contains it (no marker)", () => {
    expect(resolveCurrentWorktreePath(wts, "/elsewhere/x")).toBe("/elsewhere/x")
  })
})

const FIXTURE: WorktreeInfo[] = [
  { path: "/repo", branch: "main", head: "abc1234" },
  { path: "/repo-feature", branch: "feature/api", head: "def5678" },
  { path: "/repo-locked", branch: "feature/ui", head: "ghi9abc", locked: true },
  { path: "/repo-detached", branch: "(detached)", head: "jkl0def", detached: true },
  { path: "/repo-gone", branch: "orphan", head: "mno1111", prunable: true },
]

const GIT_ROOT = "/repo"
const CURRENT = "/repo-feature"

describe("renderDefault", () => {
  it("renders compact listing with current marker and tags", () => {
    const out = renderDefault(FIXTURE, CURRENT, GIT_ROOT)

    // main worktree has [main] tag
    expect(out).toContain("[main]")
    // locked shows tag
    expect(out).toContain("[locked]")
    // prunable shows tag
    expect(out).toContain("[prunable]")
    // current worktree has arrow
    const lines = out.trimEnd().split("\n")
    const currentLine = lines.find((l) => l.includes("/repo-feature"))
    expect(currentLine).toMatch(/^→/)
    // non-current has padding
    const mainLine = lines.find((l) => l.includes("/repo ") || l.endsWith("/repo  [main]"))
    expect(mainLine).toMatch(/^ {2}/)
  })

  it("aligns branch and path columns based on widest value", () => {
    const out = renderDefault(FIXTURE, CURRENT, GIT_ROOT)
    const lines = out.trimEnd().split("\n")
    // All lines should have their branch and path starting at the same column offsets
    // We can verify by checking that each line has two double-space separators past the marker
    for (const line of lines) {
      expect(line.slice(0, 2)).toMatch(/^(→ | {2})/)
    }
  })

  it("returns 'No worktrees found' when list is empty", () => {
    expect(renderDefault([], CURRENT, GIT_ROOT)).toBe("No worktrees found\n")
  })
})

describe("renderLong", () => {
  const enriched: EnrichedWorktreeInfo[] = [
    {
      path: "/repo",
      branch: "main",
      head: "abc",
      shortHash: "abc1234",
      subject: "feat: do thing",
      ageRelative: "2h ago",
      ageTimestamp: "2026-04-19T10:00:00Z",
      dirty: true,
    },
    {
      path: "/repo-gone",
      branch: "orphan",
      head: "mno1111",
      prunable: true,
      shortHash: "",
      subject: "",
      ageRelative: "",
      ageTimestamp: "",
      dirty: false,
      enrichmentError: "spawn ENOENT",
    },
  ]

  it("includes headers and columns", () => {
    const out = renderLong(enriched, "/repo", "/repo")
    expect(out).toContain("BRANCH")
    expect(out).toContain("COMMIT")
    expect(out).toContain("AGE")
    expect(out).toContain("PATH")
    expect(out).toContain("abc1234")
    expect(out).toContain("2h ago")
  })

  it("marks dirty worktrees with asterisk", () => {
    const out = renderLong(enriched, "/repo", "/repo")
    const lines = out.trimEnd().split("\n")
    const mainLine = lines.find((l) => l.includes("abc1234"))
    expect(mainLine).toMatch(/\*/) // contains dirty flag
  })

  it("omits subject for worktrees with enrichment errors", () => {
    const out = renderLong(enriched, "/repo", "/repo")
    expect(out).not.toContain("spawn ENOENT")
    expect(out).toContain("[prunable]")
  })
})

describe("renderPaths", () => {
  it("prints one absolute path per line with no header or marker", () => {
    const out = renderPaths(FIXTURE)
    const lines = out.trimEnd().split("\n")
    expect(lines).toHaveLength(FIXTURE.length)
    expect(lines[0]).toBe("/repo")
    expect(lines[1]).toBe("/repo-feature")
    expect(out).not.toContain("→")
    expect(out).not.toContain("[main]")
  })

  it("returns empty string when no worktrees", () => {
    expect(renderPaths([])).toBe("")
  })
})

describe("renderJson", () => {
  it("includes flags and identity markers", () => {
    const out = renderJson(FIXTURE, CURRENT, GIT_ROOT)
    const parsed = JSON.parse(out)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(FIXTURE.length)

    const main = parsed.find((x: { branch: string }) => x.branch === "main")
    expect(main).toMatchObject({ isMain: true, isCurrent: false })

    const current = parsed.find((x: { branch: string }) => x.branch === "feature/api")
    expect(current).toMatchObject({ isMain: false, isCurrent: true })

    const locked = parsed.find((x: { branch: string }) => x.branch === "feature/ui")
    expect(locked.locked).toBe(true)
  })

  it("includes enrichment fields when input is enriched", () => {
    const enriched: EnrichedWorktreeInfo[] = [
      {
        path: "/repo",
        branch: "main",
        head: "abc",
        shortHash: "abc1234",
        subject: "hi",
        ageRelative: "now",
        ageTimestamp: "2026-04-19T00:00:00Z",
        dirty: false,
      },
    ]
    const out = renderJson(enriched, "/repo", "/repo")
    const parsed = JSON.parse(out)
    expect(parsed[0]).toMatchObject({
      shortHash: "abc1234",
      subject: "hi",
      ageRelative: "now",
      ageTimestamp: "2026-04-19T00:00:00Z",
      dirty: false,
    })
  })

  it("produces valid JSON for empty array", () => {
    expect(JSON.parse(renderJson([], "/", "/"))).toEqual([])
  })
})

describe("renderLong column alignment with wide (CJK) ageRelative", () => {
  // Regression: ageWidth was computed with .length while padRight uses visualWidth,
  // so CJK relative dates (e.g. "3日前" = 3 code units but 5 display columns)
  // desynced the AGE column and everything after it.
  const enriched = (path: string, branch: string, ageRelative: string): EnrichedWorktreeInfo => ({
    path,
    branch,
    head: "h",
    shortHash: "abcdef0",
    subject: "subject",
    ageRelative,
    ageTimestamp: "2026-04-19T00:00:00Z",
    dirty: false,
  })

  it("keeps the PATH column at one visual offset across mixed-width ages", () => {
    // All-CJK so the widest-by-display entry ("3日前", width 5) has a SMALLER .length
    // (3) than its width — the exact shape that broke the old .length-based ageWidth.
    const rows: EnrichedWorktreeInfo[] = [
      enriched("/repoA", "main", "3日前"), // visualWidth 5, length 3
      enriched("/repoB", "dev", "今"), // visualWidth 2, length 1
    ]
    const out = renderLong(rows, "/none", "/repoA")
    const lines = out.split("\n").filter(Boolean)

    // The header's PATH column must start at the same VISUAL column as every row's path.
    const header = lines[0]
    const headerPathOffset = visualWidth(header.slice(0, header.indexOf("PATH")))
    for (const line of lines.slice(1)) {
      const pathOffset = visualWidth(line.slice(0, line.indexOf("/repo")))
      expect(pathOffset).toBe(headerPathOffset)
    }
  })
})
