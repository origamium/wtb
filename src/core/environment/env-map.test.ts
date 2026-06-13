/**
 * @fileoverview env-map.ts のユニットテスト
 */

import * as os from "node:os"
import * as path from "node:path"
import fs from "fs-extra"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { WtbConfig } from "../../types/index.js"
import { buildWorktreeEnvMap } from "./env-map.js"

// =============================================================================
// テスト用ヘルパー
// =============================================================================

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wtb-envmap-test-"))
})

afterEach(() => {
  fs.removeSync(tmpDir)
})

function makeConfig(files: string[]): WtbConfig {
  return {
    base_branch: "main",
    docker_compose_file: "docker-compose.yml",
    copy_files: [],
    link_files: [],
    env: { file: files, adjust: {} },
  }
}

function writeEnv(filename: string, content: string): void {
  fs.writeFileSync(path.join(tmpDir, filename), content, "utf-8")
}

// =============================================================================
// buildWorktreeEnvMap
// =============================================================================

describe("buildWorktreeEnvMap", () => {
  it("reads all keys from a single env file", () => {
    writeEnv(".env", "APP_PORT=3000\nDB_PORT=5432\nREDIS_URL=redis://localhost:6379")
    const result = buildWorktreeEnvMap(tmpDir, makeConfig([".env"]))
    expect(result).toMatchObject({
      APP_PORT: "3000",
      DB_PORT: "5432",
      REDIS_URL: "redis://localhost:6379",
    })
  })

  it("later files override earlier files (last-wins)", () => {
    writeEnv(".env", "APP_PORT=3000\nDB_PORT=5432")
    writeEnv(".env.local", "APP_PORT=3001\nEXTRA=hello")
    const result = buildWorktreeEnvMap(tmpDir, makeConfig([".env", ".env.local"]))
    // APP_PORT overridden by .env.local
    expect(result.APP_PORT).toBe("3001")
    // DB_PORT kept from .env
    expect(result.DB_PORT).toBe("5432")
    // EXTRA added by .env.local
    expect(result.EXTRA).toBe("hello")
  })

  it("skips missing files silently", () => {
    writeEnv(".env", "APP_PORT=3000")
    // .env.missing does not exist — should be skipped without throwing
    const result = buildWorktreeEnvMap(tmpDir, makeConfig([".env", ".env.missing"]))
    expect(result.APP_PORT).toBe("3000")
    // no crash
  })

  it("returns empty object when all files are missing", () => {
    const result = buildWorktreeEnvMap(tmpDir, makeConfig([".env.nope"]))
    expect(result).toEqual({})
  })

  it("includes ALL keys, not only adjust keys", () => {
    writeEnv(".env", "APP_PORT=3000\nDB_PORT=5432\nSECRET_KEY=abc123\nFEATURE_FLAG=true")
    // adjust only mentions APP_PORT and DB_PORT
    const config: WtbConfig = {
      base_branch: "main",
      docker_compose_file: "docker-compose.yml",
      copy_files: [],
      link_files: [],
      env: {
        file: [".env"],
        adjust: { APP_PORT: 3001, DB_PORT: 5433 },
      },
    }
    const result = buildWorktreeEnvMap(tmpDir, config)
    // adjust 対象外のキーも含まれること
    expect(result.SECRET_KEY).toBe("abc123")
    expect(result.FEATURE_FLAG).toBe("true")
  })

  it("returns empty object when env.file is empty", () => {
    const result = buildWorktreeEnvMap(tmpDir, makeConfig([]))
    expect(result).toEqual({})
  })

  it("resolves file paths relative to worktreePath", () => {
    // ネストしたサブディレクトリを作成
    const subDir = path.join(tmpDir, "subdir")
    fs.mkdirpSync(subDir)
    fs.writeFileSync(path.join(subDir, ".env"), "SUB_KEY=sub_value", "utf-8")
    const result = buildWorktreeEnvMap(tmpDir, makeConfig(["subdir/.env"]))
    expect(result.SUB_KEY).toBe("sub_value")
  })
})
