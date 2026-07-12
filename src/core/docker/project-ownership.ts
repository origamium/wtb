/**
 * @fileoverview Cross-worktree Compose project identity guards.
 */

import { existsSync, realpathSync } from "node:fs"
import * as path from "node:path"
import { resolveRepositoryPath } from "../config/paths.js"
import type { WorktreeInfo } from "../../types/index.js"
import { execDockerSafe } from "../../utils/exec.js"
import { safeResolveComposeProjectName } from "./compose.js"

/** Docker could not prove the owner of an existing Compose project. */
export class DockerComposeProjectInspectionError extends Error {}

/**
 * Prove that `targetProject` is not used by any other live worktree.
 *
 * Comparing only with main is insufficient when multiple target `.env` files
 * set the same COMPOSE_PROJECT_NAME. A destructive down/remove for one would
 * then tear down its sibling. Any unreadable existing sibling Compose file is
 * fail-closed because uniqueness cannot be established.
 */
export function assertComposeProjectUnique(
  worktrees: WorktreeInfo[],
  targetWorktreePath: string,
  composeRelativePath: string,
  targetProject: string
): void {
  if (worktrees.length === 0) {
    throw new Error("Could not enumerate Git worktrees while checking Compose project ownership")
  }

  for (const worktree of worktrees) {
    if (canonicalPath(worktree.path) === canonicalPath(targetWorktreePath)) continue
    const composePath = resolveRepositoryPath(worktree.path, composeRelativePath, {
      field: "sibling docker_compose_file",
      rejectSymlinkAncestors: true,
    })
    if (!existsSync(composePath)) continue
    const siblingProject = safeResolveComposeProjectName(composePath, worktree.path)
    if (siblingProject === null) {
      throw new Error(
        `Could not resolve Compose project for sibling worktree '${worktree.branch ?? worktree.path}'`
      )
    }
    if (siblingProject === targetProject) {
      throw new Error(
        `Compose project '${targetProject}' is also owned by sibling worktree '${worktree.branch ?? worktree.path}'`
      )
    }
  }
}

/**
 * Reject an already-created Compose project whose stopped/running containers
 * belong to another worktree or Compose file. Git worktree metadata alone is
 * insufficient when a sibling Compose file was deleted after its stack was
 * created.
 */
export function assertDockerComposeProjectOwnedByWorktree(
  targetProject: string,
  targetWorktreePath: string,
  composeRelativePath: string
): void {
  let output: string
  try {
    output = execDockerSafe(
      [
        "ps",
        "-a",
        "--filter",
        `label=com.docker.compose.project=${targetProject}`,
        "--format",
        "{{.ID}}",
      ],
      {}
    )
  } catch (error) {
    throw new DockerComposeProjectInspectionError(
      `Cannot enumerate containers for Compose project '${targetProject}': ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const expectedWorktree = canonicalPath(targetWorktreePath)
  const expectedCompose = canonicalPath(
    resolveRepositoryPath(targetWorktreePath, composeRelativePath, {
      field: "docker_compose_file target ownership",
      rejectSymlinkAncestors: true,
    })
  )
  for (const containerId of output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    let rawLabels: string
    try {
      rawLabels = execDockerSafe(
        ["inspect", "--format", "{{json .Config.Labels}}", containerId],
        {}
      )
    } catch (error) {
      throw new DockerComposeProjectInspectionError(
        `Cannot inspect Compose ownership for container '${containerId}': ${error instanceof Error ? error.message : String(error)}`
      )
    }
    let labels: unknown
    try {
      labels = JSON.parse(rawLabels)
    } catch {
      throw new DockerComposeProjectInspectionError(
        `Cannot parse Compose ownership labels for container '${containerId}'`
      )
    }
    if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
      throw new Error(`Container '${containerId}' has no verifiable Compose ownership labels`)
    }
    const values = labels as Record<string, unknown>
    const project = values["com.docker.compose.project"]
    const workingDir = values["com.docker.compose.project.working_dir"]
    const configFiles = values["com.docker.compose.project.config_files"]
    const parsedConfigFiles =
      typeof configFiles === "string"
        ? configFiles.split(",").map((file) => file.trim()).filter(Boolean)
        : []
    const ownsExpectedConfig =
      parsedConfigFiles.length > 0 &&
      parsedConfigFiles.every((file) => isExpectedComposeConfigFile(file, expectedCompose))
    if (
      project !== targetProject ||
      typeof workingDir !== "string" ||
      canonicalPath(workingDir) !== expectedWorktree ||
      !ownsExpectedConfig
    ) {
      throw new Error(
        `Compose project '${targetProject}' already has container '${containerId}' owned by another worktree or Compose file`
      )
    }
  }
}

function isExpectedComposeConfigFile(candidate: string, expectedCompose: string): boolean {
  const canonicalCandidate = canonicalPath(candidate)
  if (canonicalCandidate === expectedCompose) return true
  if (path.dirname(canonicalCandidate) !== path.dirname(expectedCompose)) return false
  const escapedBase = path.basename(expectedCompose).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(
    `^\\.${escapedBase}\\.wtb-snapshot-\\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.yml$`,
    "i"
  ).test(path.basename(canonicalCandidate))
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}
