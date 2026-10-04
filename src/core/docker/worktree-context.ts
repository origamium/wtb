/** Resolve a worktree and prove its Compose project is exclusively owned. */
import { existsSync } from "node:fs"
import * as path from "node:path"
import { EXIT_CODES } from "../../constants/index.js"
import type { WtbConfig } from "../../types/index.js"
import { CLIError, getErrorMessage } from "../../utils/error.js"
import { loadConfig } from "../config/loader.js"
import { resolveRepositoryPath } from "../config/paths.js"
import { getRepositoryContext, type RepositoryContext } from "../git/repository.js"
import { canonicalPath, getWorktreePath, isSamePath, listWorktrees } from "../git/worktree.js"
import { safeResolveComposeProjectName } from "./compose.js"
import {
  assertComposeProjectUnique,
  assertDockerComposeProjectOwnedByWorktree,
  DockerComposeProjectInspectionError,
} from "./project-ownership.js"

export interface WorktreeContext {
  repository: RepositoryContext
  worktreePath: string
  targetBranch: string
  config: WtbConfig
}

export interface WorktreeComposeContext extends WorktreeContext {
  composePath: string
  targetProject: string
}

export interface ComposeContextOptions {
  runDocker?: (args: string[]) => string
}

/** Resolve current/explicit worktrees without ever allowing the source worktree. */
export function resolveWorktreeContext(
  branch: string | undefined,
  command: string
): WorktreeContext {
  const repository = getRepositoryContext()
  let worktreePath: string
  let targetBranch: string
  if (branch) {
    const resolved = getWorktreePath(branch)
    if (!resolved) {
      console.error("Available worktrees:")
      for (const worktree of listWorktrees()) {
        console.error(`  ${worktree.branch}: ${worktree.path}`)
      }
      throw new CLIError(`No worktree found for branch '${branch}'`, EXIT_CODES.GENERAL_ERROR)
    }
    worktreePath = resolved
    targetBranch = branch
  } else {
    const cwd = canonicalPath(process.cwd())
    const match = listWorktrees()
      .map((worktree) => ({ worktree, canonical: canonicalPath(worktree.path) }))
      .filter(({ canonical }) => cwd === canonical || cwd.startsWith(`${canonical}${path.sep}`))
      .sort((a, b) => b.canonical.length - a.canonical.length)[0]
    if (!match) {
      throw new CLIError(
        `Could not determine the current worktree — run \`wtb ${command} <branch>\` with an explicit branch, or cd into a worktree.`,
        EXIT_CODES.GENERAL_ERROR
      )
    }
    worktreePath = match.worktree.path
    targetBranch = match.worktree.branch
  }
  if (isSamePath(worktreePath, repository.mainRoot)) {
    throw new CLIError(
      `Refusing to run '${command}' against the main repository worktree — run 'docker compose ${command}' directly in the source repository instead.`,
      EXIT_CODES.GENERAL_ERROR
    )
  }
  return { repository, worktreePath, targetBranch, config: loadConfig(repository.mainRoot) }
}

export function assertWorktreeComposeContext(
  context: WorktreeContext,
  command: string,
  options: ComposeContextOptions = {}
): WorktreeComposeContext {
  const { repository, worktreePath, config } = context
  const gitRoot = repository.mainRoot
  if (!config.docker_compose_file) {
    throw new CLIError(
      "No docker_compose_file is configured — there is no Compose stack for wtb to manage. Set docker_compose_file in your wtb config.",
      EXIT_CODES.CONFIG_ERROR
    )
  }
  const composePath = resolveRepositoryPath(worktreePath, config.docker_compose_file, {
    field: "docker_compose_file target",
    rejectSymlinkAncestors: true,
  })
  if (!existsSync(composePath)) {
    throw new CLIError(
      `No compose file at ${config.docker_compose_file} inside the worktree (${worktreePath}) — cannot run 'docker compose ${command}' for it.`,
      EXIT_CODES.GENERAL_ERROR
    )
  }
  const sourceComposePath = resolveRepositoryPath(gitRoot, config.docker_compose_file, {
    field: "docker_compose_file source",
    rejectSymlinkAncestors: true,
  })
  const sourceComposeExists = existsSync(sourceComposePath)
  const sourceProject = sourceComposeExists
    ? safeResolveComposeProjectName(sourceComposePath, gitRoot)
    : undefined
  const targetProject = safeResolveComposeProjectName(composePath, worktreePath)
  if (sourceComposeExists && sourceProject === null) {
    throw new CLIError(
      `Could not resolve the source Compose project — refusing to run 'docker compose ${command}' without proving project ownership.`,
      EXIT_CODES.GENERAL_ERROR
    )
  }
  if (targetProject === null) {
    throw new CLIError(
      `Could not resolve this worktree's Compose project name (compose file unreadable) — refusing to run 'docker compose ${command}' against an unknown project.`,
      EXIT_CODES.GENERAL_ERROR
    )
  }
  if (sourceProject !== undefined && targetProject === sourceProject) {
    throw new CLIError(
      `This worktree resolves to the SAME Compose project as the source ('${targetProject}'), so 'docker compose ${command}' would hit your source stack. Unset COMPOSE_PROJECT_NAME or make the compose 'name:' per-worktree, then retry.`,
      EXIT_CODES.GENERAL_ERROR
    )
  }
  try {
    assertComposeProjectUnique(
      listWorktrees(gitRoot),
      worktreePath,
      config.docker_compose_file,
      targetProject
    )
    if (options.runDocker) {
      assertDockerComposeProjectOwnedByWorktree(
        targetProject,
        worktreePath,
        config.docker_compose_file,
        options.runDocker
      )
    } else {
      assertDockerComposeProjectOwnedByWorktree(
        targetProject,
        worktreePath,
        config.docker_compose_file
      )
    }
  } catch (error) {
    throw new CLIError(
      `Could not prove exclusive ownership of Compose project '${targetProject}': ${getErrorMessage(error)}`,
      error instanceof DockerComposeProjectInspectionError
        ? EXIT_CODES.DOCKER_ERROR
        : EXIT_CODES.GENERAL_ERROR
    )
  }
  return { ...context, composePath, targetProject }
}

export function resolveWorktreeComposeContext(
  branch?: string,
  command = "up",
  options: ComposeContextOptions = {}
): WorktreeComposeContext {
  return assertWorktreeComposeContext(resolveWorktreeContext(branch, command), command, options)
}
