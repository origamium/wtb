/**
 * @fileoverview execSafeSync のエラー整形のテスト
 * 失敗時に単一の "Command failed: <cmd>" prefix + 実 stderr を載せ、prefix を重複
 * させないこと、binary 不在 (ENOENT) でも情報を失わないことを検証する。
 */

import { describe, expect, it } from "vitest"
import { execSafeSync } from "./exec.js"

describe("execSafeSync error formatting", () => {
  it("returns trimmed stdout on success", () => {
    const out = execSafeSync("node", ["-e", "process.stdout.write('hello\\n')"])
    expect(out).toBe("hello")
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
