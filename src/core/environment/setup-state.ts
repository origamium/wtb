import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync, readlinkSync, type Stats } from "node:fs"
import * as path from "node:path"
import { atomicWriteFileSync } from "../../utils/atomic-file.js"
import { execGitSafe } from "../../utils/exec.js"
import { resolveRepositoryPath } from "../config/paths.js"
import { canonicalPath, gitHashObject, listSkipWorktreePaths } from "../git/worktree.js"

export interface SetupState {
  version: 1
  path: string
  commonGitDir: string
  branch: string
  fingerprint: string
  status: "preparing" | "complete" | "failed" | "torn-down"
  phase: string
  pid: number
  artifacts: Record<string, string>
  error?: string
}

export const SETUP_RECOVERY =
  "Setup was not replayed. Inspect the reported phase and preserved files. After repairing environment/Compose files, recover data with 'wtb reclone --strict', run any failed seed/start_command manually, then use 'wtb up' and 'wtb await'. Do not delete the setup record to retry over existing data. To start over, archive this worktree in Orca after saving your changes and create a fresh worktree."

function statePath(worktreePath: string): string {
  const raw = execGitSafe(["rev-parse", "--git-path", "wtb-setup.json"], { cwd: worktreePath })
  if (!raw) throw new Error("Cannot resolve worktree setup record")
  const filename = path.resolve(worktreePath, raw)
  const stat = statOrNull(filename)
  if (stat && !stat.isFile()) throw new Error("Setup record is not a regular file")
  return filename
}

function statOrNull(filename: string): Stats | null {
  try {
    return lstatSync(filename)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export function readSetupState(worktreePath: string): SetupState | null {
  const filename = statePath(worktreePath)
  if (!statOrNull(filename)) return null
  const value = JSON.parse(readFileSync(filename, "utf8")) as SetupState
  if (
    !value ||
    value.version !== 1 ||
    value.path !== canonicalPath(worktreePath) ||
    typeof value.commonGitDir !== "string" ||
    typeof value.branch !== "string" ||
    typeof value.fingerprint !== "string" ||
    typeof value.phase !== "string" ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    !["preparing", "complete", "failed", "torn-down"].includes(value.status) ||
    !value.artifacts ||
    typeof value.artifacts !== "object" ||
    Array.isArray(value.artifacts)
  ) {
    throw new Error("Invalid setup record; preserve it and inspect the worktree before recovery")
  }
  for (const [relative, hash] of Object.entries(value.artifacts)) {
    resolveRepositoryPath(worktreePath, relative, { field: "setup artifact" })
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
      throw new Error("Invalid setup artifact hash")
  }
  return value
}

export function writeSetupState(worktreePath: string, state: SetupState): void {
  atomicWriteFileSync(statePath(worktreePath), `${JSON.stringify(state, null, 2)}\n`)
}

export function setupFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

/** Hash contents/mode/link identity, never follow a linked directory into main. */
function artifactHash(filename: string): string {
  const hash = createHash("sha256")
  const visit = (current: string, relative: string): void => {
    const stat = statOrNull(current)
    hash.update(JSON.stringify([relative, stat ? stat.mode & 0o777 : "absent"]))
    if (!stat) return
    if (stat.isSymbolicLink()) hash.update(`link:${readlinkSync(current)}`)
    else if (stat.isFile()) {
      hash.update("file:")
      hash.update(readFileSync(current))
    } else if (stat.isDirectory()) {
      hash.update("directory:")
      for (const child of readdirSync(current).sort())
        visit(path.join(current, child), path.join(relative, child))
    } else throw new Error(`Unsupported setup artifact: ${current}`)
  }
  visit(filename, "")
  return hash.digest("hex")
}

export function captureSetupArtifacts(
  worktreePath: string,
  relatives: string[]
): Record<string, string> {
  return Object.fromEntries(
    relatives.map((relative) => [
      relative,
      artifactHash(
        resolveRepositoryPath(worktreePath, relative, {
          field: "setup artifact",
          rejectSymlinkAncestors: true,
        })
      ),
    ])
  )
}

export function assertSetupArtifactsUnchanged(worktreePath: string, state: SetupState): void {
  const current = captureSetupArtifacts(worktreePath, Object.keys(state.artifacts))
  for (const [relative, hash] of Object.entries(state.artifacts)) {
    if (current[relative] !== hash)
      throw new Error(`Setup artifact changed: ${relative}. ${SETUP_RECOVERY}`)
  }
}

/** Reject overwriting user data in a checkout that wtb did not create. */
export function assertFreshSetupTargets(
  worktreePath: string,
  sourceRoot: string,
  relatives: string[],
  links: string[]
): void {
  if (relatives.length === 0) return
  const covers = (entry: string) =>
    relatives.some((root) => entry === root || entry.startsWith(`${root}/`))
  for (const relative of listSkipWorktreePaths(worktreePath)) {
    if (covers(relative)) throw new Error(`Setup target already has skip-worktree set: ${relative}`)
  }
  const changes = execGitSafe(["diff", "--name-only", "-z", "HEAD", "--", ...relatives], {
    cwd: worktreePath,
    preserveLeadingWhitespace: true,
  })
    .split("\0")
    .filter(Boolean)
  if (changes.length) throw new Error(`Setup would overwrite edited files: ${changes.join(", ")}`)
  const tracked = new Map<string, { mode: string; hash: string }>()
  const index = execGitSafe(["ls-files", "--stage", "-z", "--", ...relatives], {
    cwd: worktreePath,
    preserveLeadingWhitespace: true,
  })
  for (const entry of index.split("\0").filter(Boolean)) {
    const match = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(entry)
    if (!match || match[3] !== "0") throw new Error("Setup cannot overwrite an unmerged index")
    tracked.set(match[4], { mode: match[1], hash: match[2] })
  }
  const visit = (relative: string): void => {
    const filename = resolveRepositoryPath(worktreePath, relative, {
      field: "setup target",
      rejectSymlinkAncestors: true,
    })
    const stat = statOrNull(filename)
    if (!stat) return
    // Orca may already have installed an identical shared-directory link.
    if (
      links.includes(relative) &&
      stat.isSymbolicLink() &&
      path.resolve(path.dirname(filename), readlinkSync(filename)) ===
        path.resolve(sourceRoot, relative)
    )
      return
    if (stat.isDirectory()) {
      for (const child of readdirSync(filename)) visit(`${relative}/${child}`)
      return
    }
    const entry = tracked.get(relative)
    if (
      !entry ||
      !stat.isFile() ||
      (entry.mode !== "100644" && entry.mode !== "100755") ||
      gitHashObject(worktreePath, relative) !== entry.hash ||
      (process.platform !== "win32" && Boolean(stat.mode & 0o111) !== (entry.mode === "100755"))
    ) {
      throw new Error(`Setup would overwrite an unmanaged or edited target: ${relative}`)
    }
  }
  for (const relative of relatives) visit(relative)
}

export function assertSetupNotInProgress(worktreePath: string): void {
  const state = readSetupState(worktreePath)
  if (
    !state ||
    (state.status !== "preparing" &&
      !(state.status === "complete" && ["up", "await"].includes(state.phase)))
  )
    return
  try {
    process.kill(state.pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return
    throw error
  }
  throw new Error(
    `Setup is still running (pid ${state.pid}, phase ${state.phase}); wait before teardown`
  )
}

export function markSetupTornDown(worktreePath: string): void {
  const state = readSetupState(worktreePath)
  if (state) writeSetupState(worktreePath, { ...state, status: "torn-down", phase: "teardown" })
}
