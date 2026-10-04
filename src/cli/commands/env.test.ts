import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "../../constants/index.js"
import { adjustedEnvironment, renderEnvironment } from "./env.js"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("wtb env", () => {
  it("round-trips hostile values through a real POSIX shell without evaluating data", () => {
    const values = {
      VALUE: "spaces 'quotes' \"double\" $HOME $(printf INJECTED) `printf BAD`\nsecond line",
      EMPTY: "",
    }
    const script = `${renderEnvironment(values)}printf '%s\\0%s' "$VALUE" "$EMPTY"`
    const result = execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" })
    expect(result).toBe(`${values.VALUE}\0`)
  })

  it("only prints adjusted keys and uses later env files without exposing secrets", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wtb-env-command-"))
    dirs.push(dir)
    writeFileSync(path.join(dir, ".env"), "PORT=3001\nSECRET=never-print\nEMPTY=\n")
    writeFileSync(path.join(dir, ".env.local"), "PORT=3002\n")
    const config = {
      ...DEFAULT_CONFIG,
      env: {
        ...DEFAULT_CONFIG.env,
        file: [".env", ".env.local"],
        adjust: { PORT: 1, EMPTY: "", ABSENT: 1 },
      },
    }
    expect(adjustedEnvironment(dir, config)).toEqual({ PORT: "3002", EMPTY: "" })
    expect(renderEnvironment(adjustedEnvironment(dir, config))).not.toContain("SECRET")
  })

  it("omits removed keys even when an unprepared or edited file still contains them", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wtb-env-command-"))
    dirs.push(dir)
    writeFileSync(path.join(dir, ".env"), "REMOVED=private-value\nPORT=3001\n")
    const config = {
      ...DEFAULT_CONFIG,
      env: { ...DEFAULT_CONFIG.env, file: [".env"], adjust: { REMOVED: null, PORT: 1 } },
    }
    expect(adjustedEnvironment(dir, config)).toEqual({ PORT: "3001" })
  })
})
