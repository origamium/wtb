import { lstatSync } from "node:fs"
import * as path from "node:path"
import type { WorktreeInfo } from "../../types/index.js"
import { getErrorMessage } from "../../utils/error.js"
import { execGitSafe } from "../../utils/exec.js"
import { type CommitInfo, getCommitInfo } from "./commit-info.js"
import { gitHashObject, listSkipWorktreePaths, loadWtbManagedManifest } from "./worktree.js"

export interface FullWorktreeInfo extends WorktreeInfo, CommitInfo {
  dirty: boolean | null
  baseBranch: string
  ahead: number | null
  behind: number | null
  enrichmentError?: string
}

/** Inspect hidden generated files as well as Git status without changing skip-worktree bits. */
export function inspectWorktreeDirty(cwd: string): boolean {
  const managed = loadWtbManagedManifest(cwd)
  const managedPaths = new Set(Object.keys(managed).map((file) => path.normalize(file)))
  // Git status hides S/h/s entries. Only wtb's own recorded S entries have a
  // trusted content baseline; unknown flags must never become "clean" output.
  // The shared reader also rejects all assume-unchanged tags, including managed ones.
  for (const hidden of listSkipWorktreePaths(cwd)) {
    if (!managedPaths.has(path.normalize(hidden))) {
      throw new Error(
        `Tracked path '${hidden}' has skip-worktree set but is not recorded as wtb-managed; its changes cannot be inspected safely`
      )
    }
  }
  const intact = new Set<string>()
  for (const [file, hash] of Object.entries(managed)) {
    const normalized = path.normalize(file)
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(path.join(cwd, file))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
      throw error
    }
    if (!stat.isFile() || gitHashObject(cwd, file) !== hash) return true
    const index = execGitSafe(["ls-files", "--stage", "-z", "--", file], { cwd })
    const mode = index.split(" ", 1)[0]
    if (mode !== "100644" && mode !== "100755") return true
    if (((stat.mode & 0o111) !== 0) !== (mode === "100755")) return true
    intact.add(normalized)
  }
  const output = execGitSafe(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
    cwd,
    preserveLeadingWhitespace: true,
  })
  for (const entry of output.split("\0").filter(Boolean)) {
    // Only wtb's unchanged unstaged content rewrite may be ignored. Staged changes,
    // renames, type changes and any other path always count as user changes.
    if (entry.slice(0, 2) === " M" && intact.has(path.normalize(entry.slice(3)))) continue
    return true
  }
  return false
}

function parseCounts(value: string): { ahead: number; behind: number } {
  const match = /^(\d+)\s+(\d+)$/.exec(value.trim())
  if (!match) throw new Error("Git returned invalid ahead/behind counts")
  return { ahead: Number(match[1]), behind: Number(match[2]) }
}

export async function collectFullWorktreeStatus(
  worktrees: WorktreeInfo[],
  gitRoot: string,
  baseBranch: string
): Promise<FullWorktreeInfo[]> {
  let base: string | undefined
  let baseError: string | undefined
  const counts = new Map<string, { ahead: number; behind: number }>()
  try {
    base = execGitSafe(["rev-parse", "--verify", "--end-of-options", `${baseBranch}^{commit}`], {
      cwd: gitRoot,
    })
    try {
      const output = execGitSafe(
        ["for-each-ref", `--format=%(objectname)%09%(ahead-behind:${base})`, "refs/heads/"],
        { cwd: gitRoot }
      )
      for (const line of output.split("\n").filter(Boolean)) {
        const [head, values] = line.split("\t")
        counts.set(head, parseCounts(values))
      }
    } catch {
      // Older Git lacks the ahead-behind atom; per-commit fallback also handles detached HEAD.
      counts.clear()
    }
  } catch (error) {
    baseError = `Cannot resolve base_branch '${baseBranch}': ${getErrorMessage(error)}`
  }
  return worktrees.map((worktree) => {
    const errors: string[] = baseError ? [baseError] : []
    let commit: CommitInfo = { shortHash: "", subject: "", ageRelative: "", ageTimestamp: "" }
    let dirty: boolean | null = null
    let divergence: { ahead: number | null; behind: number | null } = { ahead: null, behind: null }
    try {
      commit = getCommitInfo(worktree.path)
    } catch (error) {
      errors.push(getErrorMessage(error))
    }
    try {
      dirty = inspectWorktreeDirty(worktree.path)
    } catch (error) {
      errors.push(getErrorMessage(error))
    }
    if (base) {
      try {
        let value = counts.get(worktree.head)
        if (!value) {
          value = parseCounts(
            execGitSafe(
              ["rev-list", "--left-right", "--count", `${worktree.head}...${base}`, "--"],
              { cwd: gitRoot }
            )
          )
          counts.set(worktree.head, value)
        }
        divergence = value
      } catch (error) {
        errors.push(getErrorMessage(error))
      }
    }
    return {
      ...worktree,
      ...commit,
      dirty,
      baseBranch,
      ...divergence,
      ...(errors.length ? { enrichmentError: errors.join("; ") } : {}),
    }
  })
}
