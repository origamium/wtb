import * as os from "node:os"
import * as path from "node:path"
import fs from "fs-extra"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { WtbConfig } from "../../types/index.js"
import {
  normalizeRepositoryRelativePath,
  resolveRepositoryPath,
  validateConfiguredPaths,
} from "./paths.js"

function config(overrides: Partial<WtbConfig> = {}): WtbConfig {
  return {
    base_branch: "main",
    docker_compose_file: "compose.yml",
    copy_files: [],
    link_files: [],
    env: {
      file: [],
      adjust: {},
      port_propagation: { enabled: true, files: [], compose: true },
    },
    ...overrides,
  }
}

describe("normalizeRepositoryRelativePath", () => {
  it("normalizes a safe repository-relative path", () => {
    expect(normalizeRepositoryRelativePath("./env/./dev.env", "env.file[0]")).toBe(
      path.join("env", "dev.env")
    )
    expect(normalizeRepositoryRelativePath("env\\dev.env", "env.file[0]")).toBe(
      path.join("env", "dev.env")
    )
  })

  it.each([
    "/tmp/secret",
    "C:\\temp\\secret",
    "../secret",
    "safe/../secret",
    ".",
    "./",
    ".git/config",
    "nested/.GIT/config",
  ])("rejects unsafe path %s", (value) => {
    expect(() => normalizeRepositoryRelativePath(value, "copy_files[0]")).toThrow()
  })
})

describe("validateConfiguredPaths", () => {
  it("rejects normalized duplicates inside one list", () => {
    const issues = validateConfiguredPaths(
      config({ copy_files: ["config/./dev", "config/dev", "config\\dev"] })
    )
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "copy_files[1]", message: expect.stringContaining("duplicates") }),
        expect.objectContaining({ field: "copy_files[2]", message: expect.stringContaining("duplicates") }),
      ])
    )
  })

  it("allows a file to be copied and then adjusted as an env file", () => {
    const issues = validateConfiguredPaths(
      config({
        copy_files: [".env"],
        env: {
          file: ["./.env"],
          adjust: {},
          port_propagation: { enabled: true, files: [".env"], compose: true },
        },
      })
    )
    expect(issues).toEqual([])
  })

  it("allows an equal copy/link path because link_files takes priority", () => {
    expect(
      validateConfiguredPaths(config({ copy_files: [".cache"], link_files: ["./.cache"] }))
    ).toEqual([])
  })

  it("rejects a link that is the parent of a write target", () => {
    const issues = validateConfiguredPaths(
      config({
        link_files: ["config"],
        env: {
          file: ["config/dev.env"],
          adjust: {},
          port_propagation: { enabled: true, files: [], compose: true },
        },
      })
    )
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "link_files[0]",
          message: expect.stringContaining("ancestor of a write"),
        }),
      ])
    )
  })

  it("rejects nested link targets", () => {
    const issues = validateConfiguredPaths(
      config({ link_files: ["node_modules", "node_modules/.cache"] })
    )
    expect(issues.some((issue) => issue.message.includes("is an ancestor"))).toBe(true)
  })
})

describe("resolveRepositoryPath", () => {
  let root: string
  let external: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wtb-path-root-"))
    external = fs.mkdtempSync(path.join(os.tmpdir(), "wtb-path-external-"))
  })

  afterEach(() => {
    fs.removeSync(root)
    fs.removeSync(external)
  })

  it("resolves a safe path below the root", () => {
    expect(resolveRepositoryPath(root, "config/dev.env")).toBe(path.join(root, "config/dev.env"))
  })

  it("rejects an existing symlink ancestor at runtime", () => {
    fs.symlinkSync(external, path.join(root, "config"))
    expect(() =>
      resolveRepositoryPath(root, "config/dev.env", {
        field: "env.file[0]",
        rejectSymlinkAncestors: true,
      })
    ).toThrow(/symlink ancestor/)
  })

  it("does not follow or reject a symlink at the leaf", () => {
    const externalFile = path.join(external, "outside.env")
    fs.writeFileSync(externalFile, "SECRET=1")
    fs.symlinkSync(externalFile, path.join(root, ".env"))
    expect(
      resolveRepositoryPath(root, ".env", {
        field: "env.file[0]",
        rejectSymlinkAncestors: true,
      })
    ).toBe(path.join(root, ".env"))
  })
})
