/**
 * @fileoverview environment/processor.ts のユニットテスト
 */

import { existsSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import fs from "fs-extra"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  backupEnvFile,
  copyAndAdjustEnvFile,
  parseEnvContent,
  restoreEnvFile,
  serializeEnvFile,
} from "./processor.js"

// =============================================================================
// テスト用一時ディレクトリ
// =============================================================================

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wtb-test-"))
})

afterEach(() => {
  fs.removeSync(tmpDir)
})

// =============================================================================
// parseEnvContent
// =============================================================================

describe("parseEnvContent", () => {
  it("should parse simple KEY=VALUE entries", () => {
    const content = "APP_PORT=3000\nDB_PORT=5432"
    const parsed = parseEnvContent(content)

    expect(parsed.entries).toHaveLength(2)
    expect(parsed.entries[0]).toMatchObject({ key: "APP_PORT", value: "3000" })
    expect(parsed.entries[1]).toMatchObject({ key: "DB_PORT", value: "5432" })
  })

  it("should preserve comment lines", () => {
    const content = "# Header comment\nAPP_PORT=3000\n# Another comment\nDB_PORT=5432"
    const parsed = parseEnvContent(content)

    expect(parsed.entries).toHaveLength(2)
    // lines should include comments in original positions
    expect(parsed.lines[0]).toMatchObject({ type: "other", content: "# Header comment" })
    expect(parsed.lines[1]).toMatchObject({ type: "entry", key: "APP_PORT", value: "3000" })
    expect(parsed.lines[2]).toMatchObject({ type: "other", content: "# Another comment" })
    expect(parsed.lines[3]).toMatchObject({ type: "entry", key: "DB_PORT", value: "5432" })
  })

  it("should preserve blank lines", () => {
    const content = "APP_PORT=3000\n\nDB_PORT=5432"
    const parsed = parseEnvContent(content)

    expect(parsed.lines[1]).toMatchObject({ type: "other", content: "" })
  })

  it("should strip surrounding quotes from values", () => {
    const content = "KEY1=\"quoted value\"\nKEY2='single quoted'"
    const parsed = parseEnvContent(content)

    expect(parsed.entries[0]).toMatchObject({ key: "KEY1", value: "quoted value" })
    expect(parsed.entries[1]).toMatchObject({ key: "KEY2", value: "single quoted" })
  })

  it("should parse inline comments", () => {
    const content = "APP_PORT=3000 # application port"
    const parsed = parseEnvContent(content)

    expect(parsed.entries[0]).toMatchObject({
      key: "APP_PORT",
      value: "3000",
      comment: "application port",
    })
  })

  it("should handle lowercase variable names (POSIX-compliant)", () => {
    const content = "app_port=3000\nDB_host=localhost"
    const parsed = parseEnvContent(content)

    expect(parsed.entries[0]).toMatchObject({ key: "app_port", value: "3000" })
    expect(parsed.entries[1]).toMatchObject({ key: "DB_host", value: "localhost" })
  })

  it("should return entries array matching lines entries", () => {
    const content = "A=1\nB=2\nC=3"
    const parsed = parseEnvContent(content)

    expect(parsed.entries).toHaveLength(3)
    expect(parsed.lines.filter((l) => l.type === "entry")).toHaveLength(3)
  })

  it("should parse CRLF (Windows) files without dropping entries", () => {
    // 回帰防止: split("\n") のままだと各行末に \r が残り KEY=VALUE 正規表現に
    // マッチせず、全エントリが解析対象から漏れていた。
    const content = "APP_PORT=3000\r\nDB_PORT=5432\r\n"
    const parsed = parseEnvContent(content)

    expect(parsed.entries).toHaveLength(2)
    expect(parsed.entries[0]).toMatchObject({ key: "APP_PORT", value: "3000" })
    expect(parsed.entries[1]).toMatchObject({ key: "DB_PORT", value: "5432" })
    // 値に \r が混入していないこと。
    expect(parsed.entries[0].value).toBe("3000")
  })

  it("should keep '#' that is inside a quoted value (not treat it as a comment)", () => {
    // 回帰防止: 旧実装は引用符の前で最初の # をコメント扱いし、URL の fragment 等を破壊した。
    const content = 'DB_URL="postgres://u:p@host/db?x=1#frag"'
    const parsed = parseEnvContent(content)

    expect(parsed.entries[0]).toMatchObject({
      key: "DB_URL",
      value: "postgres://u:p@host/db?x=1#frag",
    })
    expect(parsed.entries[0].comment).toBeUndefined()
  })

  it("should still parse a comment that follows a quoted value", () => {
    const content = 'KEY="a # b" # real comment'
    const parsed = parseEnvContent(content)

    expect(parsed.entries[0]).toMatchObject({
      key: "KEY",
      value: "a # b",
      comment: "real comment",
    })
  })
})

// =============================================================================
// serializeEnvFile (ラウンドトリップ)
// =============================================================================

describe("serializeEnvFile", () => {
  it("should preserve original order with interleaved comments", () => {
    const original = "# Header\nAPP_PORT=3000\n# Middle comment\nDB_PORT=5432\n# Footer"
    const parsed = parseEnvContent(original)
    const serialized = serializeEnvFile(parsed)

    expect(serialized).toBe(original)
  })

  it("should round-trip simple env content unchanged", () => {
    const content = "NODE_ENV=development\nAPP_PORT=3000\nDB_PORT=5432\n"
    const parsed = parseEnvContent(content)
    const serialized = serializeEnvFile(parsed)

    expect(serialized).toBe(content)
  })

  it("should serialize inline comments", () => {
    const content = "APP_PORT=3000 # port"
    const parsed = parseEnvContent(content)
    const serialized = serializeEnvFile(parsed)

    expect(serialized).toContain("APP_PORT=3000 # port")
  })

  it("should preserve blank lines in correct positions", () => {
    const content = "A=1\n\nB=2\n\nC=3"
    const parsed = parseEnvContent(content)
    const serialized = serializeEnvFile(parsed)

    expect(serialized).toBe(content)
  })
})

// =============================================================================
// copyAndAdjustEnvFile
// =============================================================================

describe("copyAndAdjustEnvFile", () => {
  it("should find next free port (+1 from original) for numeric adjustments", () => {
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.adjusted")
    fs.writeFileSync(sourcePath, "APP_PORT=3000\nDB_PORT=5432\n")

    const count = copyAndAdjustEnvFile(sourcePath, targetPath, {
      APP_PORT: 1,
      DB_PORT: 1,
    })

    expect(count).toBe(2)
    const result = fs.readFileSync(targetPath, "utf-8")
    // +1 from original, first free port
    expect(result).toContain("APP_PORT=3001")
    expect(result).toContain("DB_PORT=5433")
  })

  it("should resolve within-file port collisions by incrementing further", () => {
    // Two entries both want the next port after 3000 → second must get 3002
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.adjusted")
    fs.writeFileSync(sourcePath, "APP_PORT=3000\nADMIN_PORT=3000\n")

    copyAndAdjustEnvFile(sourcePath, targetPath, {
      APP_PORT: 1,
      ADMIN_PORT: 1,
    })

    const result = fs.readFileSync(targetPath, "utf-8")
    expect(result).toContain("APP_PORT=3001")
    expect(result).toContain("ADMIN_PORT=3002")
  })

  it("should skip already-used ports passed via usedPorts argument", () => {
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.adjusted")
    fs.writeFileSync(sourcePath, "APP_PORT=3000\n")

    // 3001 is already used by another worktree; expect 3002
    copyAndAdjustEnvFile(sourcePath, targetPath, { APP_PORT: 1 }, undefined, [3001])

    const result = fs.readFileSync(targetPath, "utf-8")
    expect(result).toContain("APP_PORT=3002")
  })

  it("should report per-key value changes via the optional changes out-parameter", () => {
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.adjusted")
    fs.writeFileSync(
      sourcePath,
      "APP_PORT=3000\nAPI_URL=http://localhost:3000\nNAME=x\nDELETE_ME=1\n"
    )

    const changes: Array<{ key: string; from: string; to: string }> = []
    const count = copyAndAdjustEnvFile(
      sourcePath,
      targetPath,
      {
        APP_PORT: 1,
        API_URL: "http://staging.example.com",
        NAME: (value) => `${value}-wt`,
        DELETE_ME: null,
      },
      undefined,
      [],
      changes
    )

    // 戻り値のカウント契約は従来どおり (削除も含む)。changes は値変更だけを報告する。
    expect(count).toBe(4)
    expect(changes).toEqual([
      { key: "APP_PORT", from: "3000", to: "3001" },
      { key: "API_URL", from: "http://localhost:3000", to: "http://staging.example.com" },
      { key: "NAME", from: "x", to: "x-wt" },
    ])
  })

  it("should replace with string values", () => {
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.out")
    fs.writeFileSync(sourcePath, "API_URL=http://localhost:3000\n")

    copyAndAdjustEnvFile(sourcePath, targetPath, {
      API_URL: "http://staging.example.com",
    })

    const result = fs.readFileSync(targetPath, "utf-8")
    expect(result).toContain("API_URL=http://staging.example.com")
  })

  it("should remove variables set to null", () => {
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.out")
    fs.writeFileSync(sourcePath, "KEEP=value\nDELETE=me\n")

    copyAndAdjustEnvFile(sourcePath, targetPath, { DELETE: null })

    const result = fs.readFileSync(targetPath, "utf-8")
    expect(result).toContain("KEEP=value")
    expect(result).not.toContain("DELETE")
  })

  it("should not confuse null deletion with literal __DELETE__ value", () => {
    // Variables whose actual value is "__DELETE__" should NOT be deleted
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.out")
    fs.writeFileSync(sourcePath, "SENTINEL=__DELETE__\nOTHER=keep\n")

    // Only delete OTHER, not SENTINEL
    copyAndAdjustEnvFile(sourcePath, targetPath, { OTHER: null })

    const result = fs.readFileSync(targetPath, "utf-8")
    expect(result).toContain("SENTINEL=__DELETE__")
    expect(result).not.toContain("OTHER=keep")
  })

  it("should add new variables not present in source", () => {
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.out")
    fs.writeFileSync(sourcePath, "EXISTING=value\n")

    const count = copyAndAdjustEnvFile(sourcePath, targetPath, {
      NEW_VAR: "new_value",
    })

    expect(count).toBe(1)
    const result = fs.readFileSync(targetPath, "utf-8")
    expect(result).toContain("NEW_VAR=new_value")
  })

  it("warns and adds nothing when a numeric (port) adjust key is absent", () => {
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.out")
    fs.writeFileSync(sourcePath, "EXISTING=value\n")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    // PORT is a port-type (numeric) adjustment but isn't in the file → wtb must
    // NOT append the meaningless marker literal (`PORT=1`); it warns and skips.
    const count = copyAndAdjustEnvFile(sourcePath, targetPath, { PORT: 1 })

    const result = fs.readFileSync(targetPath, "utf-8")
    expect(result).not.toContain("PORT=1")
    expect(result).not.toContain("PORT=")
    expect(count).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("PORT"))
    warn.mockRestore()
  })

  it("still appends an absent STRING adjust key as a literal", () => {
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.out")
    fs.writeFileSync(sourcePath, "EXISTING=value\n")

    const count = copyAndAdjustEnvFile(sourcePath, targetPath, { API_BASE: "http://x" })

    const result = fs.readFileSync(targetPath, "utf-8")
    expect(result).toContain("API_BASE=http://x")
    expect(count).toBe(1)
  })

  it("should apply function adjustments", () => {
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.out")
    fs.writeFileSync(sourcePath, "PORT=3000\n")

    copyAndAdjustEnvFile(sourcePath, targetPath, {
      PORT: (v) => String(parseInt(v, 10) * 2),
    })

    const result = fs.readFileSync(targetPath, "utf-8")
    expect(result).toContain("PORT=6000")
  })

  it("should skip non-numeric values when adjustment is numeric", () => {
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.out")
    fs.writeFileSync(sourcePath, "HOSTNAME=localhost\n")

    const count = copyAndAdjustEnvFile(sourcePath, targetPath, { HOSTNAME: 1000 })

    expect(count).toBe(0)
    const result = fs.readFileSync(targetPath, "utf-8")
    expect(result).toContain("HOSTNAME=localhost")
  })

  it("should preserve order and comments in output", () => {
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.out")
    const content = "# App config\nAPP_PORT=3000\n# DB config\nDB_PORT=5432\n"
    fs.writeFileSync(sourcePath, content)

    copyAndAdjustEnvFile(sourcePath, targetPath, { APP_PORT: 1000 })

    const result = fs.readFileSync(targetPath, "utf-8")
    // Comments should be preserved
    expect(result).toContain("# App config")
    expect(result).toContain("# DB config")
    // Order: comment, then entry
    const lines = result.split("\n")
    const appPortIdx = lines.findIndex((l) => l.startsWith("APP_PORT"))
    const commentIdx = lines.indexOf("# App config")
    expect(commentIdx).toBeLessThan(appPortIdx)
  })

  it("should handle zero adjustments correctly", () => {
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.out")
    fs.writeFileSync(sourcePath, "A=1\nB=2\n")

    const count = copyAndAdjustEnvFile(sourcePath, targetPath, {})

    expect(count).toBe(0)
    const result = fs.readFileSync(targetPath, "utf-8")
    expect(result).toContain("A=1")
    expect(result).toContain("B=2")
  })
})

// =============================================================================
// backupEnvFile / restoreEnvFile
// =============================================================================

describe("backupEnvFile", () => {
  it("should create a backup file with .backup extension", () => {
    const filePath = path.join(tmpDir, ".env")
    fs.writeFileSync(filePath, "KEY=value\n")

    const backupPath = backupEnvFile(filePath)

    expect(existsSync(backupPath)).toBe(true)
    expect(backupPath).toBe(`${filePath}.backup`)
    expect(fs.readFileSync(backupPath, "utf-8")).toBe("KEY=value\n")
  })

  it("should use custom suffix", () => {
    const filePath = path.join(tmpDir, ".env")
    fs.writeFileSync(filePath, "KEY=value\n")

    const backupPath = backupEnvFile(filePath, ".bak")

    expect(backupPath).toBe(`${filePath}.bak`)
    expect(existsSync(backupPath)).toBe(true)
  })

  it("should not throw when source does not exist", () => {
    const filePath = path.join(tmpDir, ".nonexistent")
    expect(() => backupEnvFile(filePath)).not.toThrow()
  })
})

describe("restoreEnvFile", () => {
  it("should restore file from backup", () => {
    const filePath = path.join(tmpDir, ".env")
    const backupPath = `${filePath}.backup`
    fs.writeFileSync(filePath, "CURRENT=value\n")
    fs.writeFileSync(backupPath, "ORIGINAL=value\n")

    restoreEnvFile(filePath)

    expect(fs.readFileSync(filePath, "utf-8")).toBe("ORIGINAL=value\n")
  })

  it("should throw when backup does not exist", () => {
    const filePath = path.join(tmpDir, ".env")
    fs.writeFileSync(filePath, "KEY=value\n")

    expect(() => restoreEnvFile(filePath)).toThrow("Backup file not found")
  })
})

// =============================================================================
// findNextFreePort (via copyAndAdjustEnvFile) — F3 high-port bug regression
// =============================================================================

describe("findNextFreePort via copyAndAdjustEnvFile — high-port regression (F3)", () => {
  it("original port 54321 with {54322} used → returns 54323", () => {
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.out")
    fs.writeFileSync(sourcePath, "DB_PORT=54321\n")

    // 54322 is in use — should skip to 54323
    copyAndAdjustEnvFile(sourcePath, targetPath, { DB_PORT: 1 }, undefined, [54322])

    const result = fs.readFileSync(targetPath, "utf-8")
    expect(result).toContain("DB_PORT=54323")
  })

  it("a port above 9999 finds the next free port above it (not clamped to 3000 range)", () => {
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.out")
    fs.writeFileSync(sourcePath, "SUPA_PORT=54321\n")

    // Nothing is in use — should bump to 54322 (originalPort + 1)
    copyAndAdjustEnvFile(sourcePath, targetPath, { SUPA_PORT: 1 }, undefined, [])

    const result = fs.readFileSync(targetPath, "utf-8")
    expect(result).toContain("SUPA_PORT=54322")
    // Must NOT fall back into the 3000-9999 range
    expect(result).not.toMatch(/SUPA_PORT=3\d\d\d/)
  })

  it("never returns an in-use port — wraparound case with high original port", () => {
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.out")
    fs.writeFileSync(sourcePath, "HIGH_PORT=65534\n")

    // 65535 is in use — should wraparound to PORT_RANGE.MIN (3000) since that's free
    copyAndAdjustEnvFile(sourcePath, targetPath, { HIGH_PORT: 1 }, undefined, [65535])

    const result = fs.readFileSync(targetPath, "utf-8")
    // The assigned port must not be 65535 (in use)
    expect(result).not.toContain("HIGH_PORT=65535")
    // Should have wrapped around to 3000
    expect(result).toContain("HIGH_PORT=3000")
  })

  it("does not return originalPort+1 when that port is in usedPorts (regression: old fallback)", () => {
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.out")
    fs.writeFileSync(sourcePath, "APP_PORT=54320\n")

    // 54321 is in use — old code returned originalPort+1 unconditionally; new code must skip it
    copyAndAdjustEnvFile(sourcePath, targetPath, { APP_PORT: 1 }, undefined, [54321])

    const result = fs.readFileSync(targetPath, "utf-8")
    expect(result).not.toContain("APP_PORT=54321")
    expect(result).toContain("APP_PORT=54322")
  })
})

// =============================================================================
// H2 — findNextFreePort wraparound never returns originalPort itself
// =============================================================================

describe("findNextFreePort wraparound — never returns originalPort as its own bump (H2)", () => {
  it("when everything above originalPort is used and originalPort is free, finds a lower port", () => {
    // Scenario: originalPort=3001, all of 3002..65535 are in use.
    // Old code: the wraparound loop `c <= originalPort` would return 3001 itself
    //   (it's never in usedPorts) → a no-op bump (from === to), silently sharing the port.
    // Fixed code: `c < originalPort` excludes 3001 → returns 3000 (first free below).
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.out")
    fs.writeFileSync(sourcePath, "MY_PORT=3001\n")

    const usedAbove = Array.from({ length: 65535 - 3002 + 1 }, (_, i) => 3002 + i)
    copyAndAdjustEnvFile(sourcePath, targetPath, { MY_PORT: 1 }, undefined, usedAbove)

    const result = fs.readFileSync(targetPath, "utf-8")
    // Must NOT return 3001 (the originalPort — that's a no-op bump)
    expect(result).not.toContain("MY_PORT=3001")
    // Must return 3000 (the only free port in the range below originalPort)
    expect(result).toContain("MY_PORT=3000")
  })

  it("wraparound result is never equal to originalPort", () => {
    // PORT=3005, fill all of 3006..65535 and also 3000..3004.
    // The only free slot below 3005 is none → should throw, not return 3005.
    const sourcePath = path.join(tmpDir, ".env")
    const targetPath = path.join(tmpDir, ".env.out")
    fs.writeFileSync(sourcePath, "MY_PORT=3005\n")

    // Fill everything above 3005 and everything in [3000, 3004]
    const usedAll = [
      ...Array.from({ length: 65535 - 3006 + 1 }, (_, i) => 3006 + i),
      3000,
      3001,
      3002,
      3003,
      3004,
    ]
    // Should throw (all candidates exhausted) — the important thing is it must NOT
    // silently return 3005 (the originalPort itself).
    expect(() =>
      copyAndAdjustEnvFile(sourcePath, targetPath, { MY_PORT: 1 }, undefined, usedAll)
    ).toThrow()
  })
})
