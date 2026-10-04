import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execGitSafe } from "../../utils/exec.js"
import {
  assertFreshSetupTargets,
  assertSetupArtifactsUnchanged,
  assertSetupNotInProgress,
  captureSetupArtifacts,
  markSetupTornDown,
  readSetupState,
  type SetupState,
  writeSetupState,
} from "./setup-state.js"

vi.mock("../../utils/exec.js")

describe("persistent setup safety", () => {
  let root: string
  let target: string
  let source: string
  let filename: string
  let index: string
  let flags: string
  let diff: string
  let hashes: Record<string, string>
  const state = (overrides: Partial<SetupState> = {}): SetupState => ({
    version: 1,
    path: target,
    commonGitDir: path.join(source, ".git"),
    branch: "feature/x",
    fingerprint: "fingerprint",
    status: "complete",
    phase: "complete",
    pid: process.pid,
    artifacts: {},
    ...overrides,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtb-setup-state-")))
    target = path.join(root, "target")
    source = path.join(root, "source")
    fs.mkdirSync(target)
    fs.mkdirSync(source)
    filename = path.join(root, "wtb-setup.json")
    index = ""
    flags = ""
    diff = ""
    hashes = {}
    vi.mocked(execGitSafe).mockImplementation((args) => {
      if (args[0] === "rev-parse") return filename
      if (args[0] === "ls-files") return args.includes("--stage") ? index : flags
      if (args[0] === "diff") return diff
      if (args[0] === "hash-object") return hashes[args[args.length - 1]] ?? ""
      throw new Error(`Unexpected Git invocation: ${args.join(" ")}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("preserves an existing record when teardown invalidates prepared data", () => {
    const original = state({ artifacts: { ".env": "a".repeat(64) } })
    writeSetupState(target, original)
    markSetupTornDown(target)
    expect(readSetupState(target)).toEqual({ ...original, status: "torn-down", phase: "teardown" })
  })

  it("does not invent a setup record for a worktree that was never prepared", () => {
    expect(readSetupState(target)).toBeNull()
    markSetupTornDown(target)
    expect(fs.existsSync(filename)).toBe(false)
  })

  it.each([
    { status: "preparing", phase: "volumes" },
    { status: "complete", phase: "up" },
    { status: "complete", phase: "await" },
  ] as const)("blocks teardown while a live process owns $phase", (phase) => {
    writeSetupState(target, state(phase))
    expect(() => assertSetupNotInProgress(target)).toThrow("Setup is still running")
  })

  it("allows recovery when an interrupted owner no longer exists", () => {
    writeSetupState(target, state({ status: "preparing", phase: "volumes", pid: 12345 }))
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" })
    })
    expect(() => assertSetupNotInProgress(target)).not.toThrow()
  })

  it("fails closed when a live owner cannot be inspected", () => {
    writeSetupState(target, state({ status: "complete", phase: "up", pid: 12345 }))
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EPERM" })
    })
    expect(() => assertSetupNotInProgress(target)).toThrow("permission denied")
  })

  it.each([
    { path: "/another/worktree" },
    { pid: 0 },
    { artifacts: { "../outside": "a".repeat(64) } },
    { artifacts: { ".env": "invalid hash" } },
  ])("rejects a corrupt or unsafe record before mutation (%j)", (invalid) => {
    fs.writeFileSync(filename, JSON.stringify({ ...state(), ...invalid }))
    const original = fs.readFileSync(filename, "utf8")
    expect(() => markSetupTornDown(target)).toThrow()
    expect(fs.readFileSync(filename, "utf8")).toBe(original)
  })

  it("rejects a symlinked setup record instead of writing through it", () => {
    const outside = path.join(root, "outside.json")
    fs.writeFileSync(outside, JSON.stringify(state()))
    fs.symlinkSync(outside, filename)
    expect(() => writeSetupState(target, state())).toThrow("not a regular file")
    expect(JSON.parse(fs.readFileSync(outside, "utf8")).status).toBe("complete")
  })

  it("detects nested edits/additions inside a recorded copied directory", () => {
    fs.mkdirSync(path.join(target, "config", "nested"), { recursive: true })
    fs.writeFileSync(path.join(target, "config", "nested", "settings"), "original")
    const original = state({ artifacts: captureSetupArtifacts(target, ["config"]) })
    expect(Object.keys(original.artifacts)).toEqual(["config"])
    expect(() => assertSetupArtifactsUnchanged(target, original)).not.toThrow()
    fs.writeFileSync(path.join(target, "config", "nested", "settings"), "edited")
    expect(() => assertSetupArtifactsUnchanged(target, original)).toThrow("config")
    fs.writeFileSync(path.join(target, "config", "nested", "settings"), "original")
    fs.writeFileSync(path.join(target, "config", "local-only"), "new")
    expect(() => assertSetupArtifactsUnchanged(target, original)).toThrow("config")
  })

  it("records link identity without following changes in the shared source directory", () => {
    fs.mkdirSync(path.join(source, "node_modules"))
    fs.writeFileSync(path.join(source, "node_modules", "package"), "version 1")
    fs.symlinkSync(path.join(source, "node_modules"), path.join(target, "node_modules"))
    const original = state({ artifacts: captureSetupArtifacts(target, ["node_modules"]) })
    fs.writeFileSync(path.join(source, "node_modules", "package"), "version 2")
    expect(() => assertSetupArtifactsUnchanged(target, original)).not.toThrow()
    fs.unlinkSync(path.join(target, "node_modules"))
    fs.symlinkSync(source, path.join(target, "node_modules"))
    expect(() => assertSetupArtifactsUnchanged(target, original)).toThrow("node_modules")
  })

  it("does not follow symlink children of a copied directory into source data", () => {
    fs.mkdirSync(path.join(target, "config"))
    fs.writeFileSync(path.join(source, "shared.env"), "one")
    fs.symlinkSync(path.join(source, "shared.env"), path.join(target, "config", "shared.env"))
    const original = state({ artifacts: captureSetupArtifacts(target, ["config"]) })
    fs.writeFileSync(path.join(source, "shared.env"), "two")
    expect(() => assertSetupArtifactsUnchanged(target, original)).not.toThrow()
  })

  it("detects creation of a previously absent artifact and permission changes", () => {
    const absent = state({ artifacts: captureSetupArtifacts(target, [".env"]) })
    fs.writeFileSync(path.join(target, ".env"), "PORT=3001", { mode: 0o600 })
    expect(() => assertSetupArtifactsUnchanged(target, absent)).toThrow(".env")
    const present = state({ artifacts: captureSetupArtifacts(target, [".env"]) })
    fs.chmodSync(path.join(target, ".env"), 0o644)
    expect(() => assertSetupArtifactsUnchanged(target, present)).toThrow(".env")
  })

  it("accepts pristine tracked files but refuses unmanaged or modified data", () => {
    fs.writeFileSync(path.join(target, ".env"), "original")
    index = "100644 abc123 0\t.env\0"
    hashes[".env"] = "abc123"
    expect(() => assertFreshSetupTargets(target, source, [".env"], [])).not.toThrow()
    hashes[".env"] = "different"
    expect(() => assertFreshSetupTargets(target, source, [".env"], [])).toThrow("edited target")
    index = ""
    expect(() => assertFreshSetupTargets(target, source, [".env"], [])).toThrow("unmanaged")
  })

  it("accepts an Orca-created link only when it points to the matching main directory", () => {
    fs.mkdirSync(path.join(source, "node_modules"))
    fs.symlinkSync(path.join(source, "node_modules"), path.join(target, "node_modules"))
    expect(() =>
      assertFreshSetupTargets(target, source, ["node_modules"], ["node_modules"])
    ).not.toThrow()
    fs.unlinkSync(path.join(target, "node_modules"))
    fs.symlinkSync(source, path.join(target, "node_modules"))
    expect(() =>
      assertFreshSetupTargets(target, source, ["node_modules"], ["node_modules"])
    ).toThrow("unmanaged")
  })

  it.each([
    "S config/settings\0",
    "h config/settings\0",
  ])("rejects concealed Git changes (%s)", (value) => {
    flags = value
    expect(() => assertFreshSetupTargets(target, source, ["config"], [])).toThrow()
  })
})
