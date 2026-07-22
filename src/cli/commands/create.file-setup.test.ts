import * as os from "node:os"
import * as path from "node:path"
import fs from "fs-extra"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  assertSetupSourceDoesNotContainWorktree,
  copyConfiguredFiles,
  linkConfiguredFiles,
} from "./create.js"

describe("create file setup safety", () => {
  let sourceRoot: string
  let targetRoot: string
  let externalRoot: string

  beforeEach(() => {
    sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wtb-copy-source-"))
    targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wtb-copy-target-"))
    externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wtb-copy-external-"))
  })

  afterEach(() => {
    fs.removeSync(sourceRoot)
    fs.removeSync(targetRoot)
    fs.removeSync(externalRoot)
  })

  it("reports a missing optional copy source as a warning", async () => {
    const result = await copyConfiguredFiles(sourceRoot, targetRoot, ["missing.env"])
    expect(result.failures).toEqual([])
    expect(result.warnings).toEqual([
      expect.objectContaining({ phase: "copy", path: "missing.env" }),
    ])
  })

  it("copies unadjusted env bytes atomically and preserves an existing target mode", async () => {
    const source = path.join(sourceRoot, ".env")
    const target = path.join(targetRoot, ".env")
    fs.writeFileSync(source, "QUOTED='a # b'\n# keep bytes\n")
    fs.writeFileSync(target, "OLD=1\n", { mode: 0o640 })
    fs.chmodSync(target, 0o640)

    const result = await copyConfiguredFiles(
      sourceRoot,
      targetRoot,
      [".env"],
      undefined,
      "env"
    )

    expect(result.failures).toEqual([])
    expect(fs.readFileSync(target, "utf8")).toBe("QUOTED='a # b'\n# keep bytes\n")
    expect(fs.statSync(target).mode & 0o777).toBe(0o640)
    expect(fs.readdirSync(targetRoot)).toEqual([".env"])
  })

  it("refuses to copy through a symlink leaf", async () => {
    fs.writeFileSync(path.join(sourceRoot, ".env"), "LOCAL=1\n")
    const outside = path.join(externalRoot, "outside.env")
    fs.writeFileSync(outside, "OUTSIDE=1\n")
    fs.symlinkSync(outside, path.join(targetRoot, ".env"))

    const result = await copyConfiguredFiles(sourceRoot, targetRoot, [".env"])

    expect(result.failures).toEqual([
      expect.objectContaining({ phase: "copy", path: ".env", message: expect.stringContaining("symlink") }),
    ])
    expect(fs.readFileSync(outside, "utf8")).toBe("OUTSIDE=1\n")
  })

  it("preflights corresponding descendants and refuses a nested destination symlink", async () => {
    fs.mkdirpSync(path.join(sourceRoot, "config", "nested"))
    fs.writeFileSync(path.join(sourceRoot, "config", "nested", "settings.json"), "source")
    fs.mkdirpSync(path.join(targetRoot, "config"))
    fs.symlinkSync(externalRoot, path.join(targetRoot, "config", "nested"))
    const outside = path.join(externalRoot, "settings.json")
    fs.writeFileSync(outside, "outside")

    const result = await copyConfiguredFiles(sourceRoot, targetRoot, ["config"])

    expect(result.failures).toEqual([
      expect.objectContaining({
        phase: "copy",
        path: "config",
        message: expect.stringContaining("copy destination is a symlink"),
      }),
    ])
    expect(fs.readFileSync(outside, "utf8")).toBe("outside")
  })

  it("atomically replaces an existing directory with a symlink and removes staging files", async () => {
    fs.mkdirpSync(path.join(sourceRoot, "shared"))
    fs.writeFileSync(path.join(sourceRoot, "shared", "new.txt"), "new")
    fs.mkdirpSync(path.join(targetRoot, "shared"))
    fs.writeFileSync(path.join(targetRoot, "shared", "old.txt"), "old")

    const result = await linkConfiguredFiles(sourceRoot, targetRoot, ["shared"])

    expect(result).toEqual({ warnings: [], failures: [] })
    const target = path.join(targetRoot, "shared")
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true)
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(path.join(sourceRoot, "shared")))
    expect(fs.readdirSync(targetRoot)).toEqual(["shared"])
  })

  it("rejects a target whose parent is a symlink and leaves the external tree untouched", async () => {
    fs.mkdirpSync(path.join(sourceRoot, "nested"))
    fs.writeFileSync(path.join(sourceRoot, "nested", "value.txt"), "source")
    fs.symlinkSync(externalRoot, path.join(targetRoot, "nested"))

    const result = await linkConfiguredFiles(sourceRoot, targetRoot, ["nested/value.txt"])

    expect(result.failures).toEqual([
      expect.objectContaining({ phase: "link", message: expect.stringContaining("symlink ancestor") }),
    ])
    expect(fs.readdirSync(externalRoot)).toEqual([])
  })

  it("turns runtime traversal attempts into setup failures", async () => {
    const result = await copyConfiguredFiles(sourceRoot, targetRoot, ["../outside"])
    expect(result.failures).toEqual([
      expect.objectContaining({ path: "../outside", message: expect.stringContaining("must not contain") }),
    ])
  })

  it("rejects copy/link sources that contain the target worktree", () => {
    const nestedTarget = path.join(sourceRoot, "worktrees", "feature")
    fs.mkdirpSync(nestedTarget)

    expect(() =>
      assertSetupSourceDoesNotContainWorktree(sourceRoot, nestedTarget, "worktrees", "copy")
    ).toThrow(/contains the target worktree/)
    expect(() =>
      assertSetupSourceDoesNotContainWorktree(sourceRoot, nestedTarget, "worktrees", "link")
    ).toThrow(/contains the target worktree/)
  })

  it("rejects a configured source equal to the target worktree root", () => {
    const nestedTarget = path.join(sourceRoot, "worktrees", "feature")
    fs.mkdirpSync(nestedTarget)

    expect(() =>
      assertSetupSourceDoesNotContainWorktree(
        sourceRoot,
        nestedTarget,
        "worktrees/feature",
        "copy"
      )
    ).toThrow(/contains the target worktree/)
  })
})
