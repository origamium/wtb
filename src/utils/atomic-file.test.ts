import * as os from "node:os"
import * as path from "node:path"
import fs from "fs-extra"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { atomicWriteFileSync } from "./atomic-file.js"

describe("atomicWriteFileSync", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wtb-atomic-file-"))
  })

  afterEach(() => {
    fs.removeSync(tmpDir)
  })

  it("replaces content and preserves an existing file mode", () => {
    const target = path.join(tmpDir, ".env")
    fs.writeFileSync(target, "OLD=1\n")
    fs.chmodSync(target, 0o640)

    atomicWriteFileSync(target, "NEW=2\n")

    expect(fs.readFileSync(target, "utf8")).toBe("NEW=2\n")
    if (process.platform !== "win32") {
      expect(fs.statSync(target).mode & 0o777).toBe(0o640)
    }
    expect(fs.readdirSync(tmpDir)).toEqual([".env"])
  })

  it("replaces a leaf symlink instead of modifying its destination", () => {
    const outside = path.join(tmpDir, "outside")
    const target = path.join(tmpDir, ".env")
    fs.writeFileSync(outside, "OUTSIDE=1\n")
    fs.symlinkSync(outside, target)

    atomicWriteFileSync(target, "LOCAL=1\n")

    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(target, "utf8")).toBe("LOCAL=1\n")
    expect(fs.readFileSync(outside, "utf8")).toBe("OUTSIDE=1\n")
  })

  it("removes its temporary sibling when replacement fails", () => {
    const target = path.join(tmpDir, "destination")
    fs.mkdirSync(target)

    expect(() => atomicWriteFileSync(target, "cannot replace a directory")).toThrow()
    expect(fs.readdirSync(tmpDir)).toEqual(["destination"])
  })
})
