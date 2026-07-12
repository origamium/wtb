/**
 * @fileoverview Repository-relative path validation and safe resolution.
 *
 * Configuration paths are data, not arbitrary filesystem paths.  Keeping all
 * configured writes below the repository root prevents a typo (or a hostile
 * config) from copying over files outside a worktree.  The runtime resolver
 * repeats the containment check and can reject symlinked parent directories so
 * lexical containment cannot be redirected elsewhere.
 */

import * as path from "node:path"
import fs from "fs-extra"
import type { WtbConfig } from "../../types/index.js"

export interface ConfigPathIssue {
  field: string
  message: string
}

export interface ResolveRepositoryPathOptions {
  /** Field name included in error messages. */
  field?: string
  /** Reject an existing symlink in any parent component below repositoryRoot. */
  rejectSymlinkAncestors?: boolean
}

interface ConfiguredPath {
  field: string
  normalized: string
}

/**
 * Normalize one configured path while enforcing the repository-relative
 * contract.  `./foo` is accepted, but a path resolving to the repository root,
 * an absolute path, any explicit `..` component, and `.git` are rejected.
 */
export function normalizeRepositoryRelativePath(value: string, field = "path"): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`)
  }
  if (value.length === 0 || value.includes("\0")) {
    throw new Error(`${field} must be a non-empty repository-relative path`)
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`${field} must be repository-relative (absolute paths are not allowed): ${value}`)
  }

  // Treat both separator styles as path separators for validation.  This also
  // prevents a config authored on Windows from becoming unsafe when moved to a
  // POSIX host (and vice versa).
  const segments = value.split(/[\\/]+/)
  if (segments.every((segment) => segment === "" || segment === ".")) {
    throw new Error(`${field} must not target the repository root`)
  }
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`${field} must not contain '..': ${value}`)
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) {
    throw new Error(`${field} must not target .git: ${value}`)
  }

  // Configuration is portable across POSIX/Windows repositories. Treat both
  // slash styles as separators before native normalization so `foo/bar` and
  // `foo\\bar` cannot bypass duplicate/conflict detection on either host.
  const normalized = path.normalize(value.replace(/[\\/]+/g, path.sep))
  if (normalized === "." || normalized === "") {
    throw new Error(`${field} must not target the repository root`)
  }

  // Defence in depth for platform-specific normalization semantics.
  const normalizedSegments = normalized.split(path.sep)
  if (normalizedSegments[0] === ".." || path.isAbsolute(normalized)) {
    throw new Error(`${field} escapes the repository: ${value}`)
  }
  return normalized
}

/** Return true when `candidate` is equal to, or nested below, `parent`. */
function isSameOrDescendant(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  return parent !== candidate && isSameOrDescendant(parent, candidate)
}

/**
 * Resolve a configured path below a repository/worktree root.
 *
 * Call this immediately before filesystem I/O.  Validation at config-load time
 * is intentionally not trusted as the only guard because callers can construct
 * WtbConfig values directly and directory entries can change after loading.
 */
export function resolveRepositoryPath(
  repositoryRoot: string,
  configuredPath: string,
  options: ResolveRepositoryPathOptions = {}
): string {
  const field = options.field ?? "path"
  const normalized = normalizeRepositoryRelativePath(configuredPath, field)
  const root = path.resolve(repositoryRoot)
  const resolved = path.resolve(root, normalized)

  if (!isSameOrDescendant(root, resolved) || resolved === root) {
    throw new Error(`${field} escapes the repository: ${configuredPath}`)
  }

  if (options.rejectSymlinkAncestors) {
    assertNoSymlinkAncestors(root, resolved, field)
  }
  return resolved
}

/**
 * Reject symlinks in parent components of `targetPath` below `repositoryRoot`.
 * The leaf itself is deliberately excluded: atomic writers replace a leaf
 * symlink rather than following it, while copy/link callers can apply their own
 * leaf policy.
 */
export function assertNoSymlinkAncestors(
  repositoryRoot: string,
  targetPath: string,
  field = "path"
): void {
  const root = path.resolve(repositoryRoot)
  const target = path.resolve(targetPath)
  if (!isSameOrDescendant(root, target) || target === root) {
    throw new Error(`${field} escapes the repository: ${targetPath}`)
  }

  const parentRelative = path.relative(root, path.dirname(target))
  if (parentRelative === "") return

  let current = root
  for (const segment of parentRelative.split(path.sep)) {
    current = path.join(current, segment)
    let stat: ReturnType<typeof fs.lstatSync>
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Descendants cannot exist beneath a missing non-symlink component.
        return
      }
      throw error
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${field} has a symlink ancestor outside the trusted path walk: ${current}`)
    }
  }
}

function collectPathList(
  values: unknown,
  field: string,
  issues: ConfigPathIssue[]
): ConfiguredPath[] {
  if (!Array.isArray(values)) return []

  const result: ConfiguredPath[] = []
  const firstByPath = new Map<string, string>()
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string") continue
    const itemField = `${field}[${index}]`
    try {
      const normalized = normalizeRepositoryRelativePath(value, itemField)
      const firstField = firstByPath.get(normalized)
      if (firstField) {
        issues.push({
          field: itemField,
          message: `${itemField} duplicates ${firstField} after path normalization: ${normalized}`,
        })
      } else {
        firstByPath.set(normalized, itemField)
      }
      result.push({ field: itemField, normalized })
    } catch (error) {
      issues.push({ field: itemField, message: (error as Error).message })
    }
  }
  return result
}

function collectSinglePath(
  value: unknown,
  field: string,
  issues: ConfigPathIssue[],
  allowEmpty = false
): ConfiguredPath[] {
  if (typeof value !== "string" || (allowEmpty && value === "")) return []
  try {
    return [{ field, normalized: normalizeRepositoryRelativePath(value, field) }]
  } catch (error) {
    issues.push({ field, message: (error as Error).message })
    return []
  }
}

/**
 * Validate every path-bearing WtbConfig field and cross-field symlink hazards.
 * Repeating the same path in different write phases is valid (`copy_files`
 * followed by `env.file` is the normal adjustment flow), but duplicates inside
 * one list are rejected.
 */
export function validateConfiguredPaths(config: WtbConfig): ConfigPathIssue[] {
  const issues: ConfigPathIssue[] = []
  const compose = collectSinglePath(
    (config as unknown as Record<string, unknown>).docker_compose_file,
    "docker_compose_file",
    issues,
    true
  )
  const copy = collectPathList(
    (config as unknown as Record<string, unknown>).copy_files,
    "copy_files",
    issues
  )
  const links = collectPathList(
    (config as unknown as Record<string, unknown>).link_files,
    "link_files",
    issues
  )

  const rawEnv = (config as unknown as { env?: Record<string, unknown> }).env
  const envFiles = collectPathList(rawEnv?.file, "env.file", issues)
  const rawPropagation = rawEnv?.port_propagation
  const propagationFiles =
    rawPropagation && typeof rawPropagation === "object" && !Array.isArray(rawPropagation)
      ? collectPathList(
          (rawPropagation as Record<string, unknown>).files,
          "env.port_propagation.files",
          issues
        )
      : []

  // Equal copy/link paths retain the documented "link wins" behavior.  A link
  // may not be a *parent* of a copied path, and it may neither equal nor contain
  // a path that a later phase writes in-place (env/compose propagation).
  for (const link of links) {
    for (const target of copy) {
      if (isStrictDescendant(link.normalized, target.normalized)) {
        issues.push({
          field: link.field,
          message: `${link.field} (${link.normalized}) conflicts with write target ${target.field} (${target.normalized}); a symlink must not be an ancestor of a copied path`,
        })
      }
    }
    for (const target of [...compose, ...envFiles, ...propagationFiles]) {
      if (!isSameOrDescendant(link.normalized, target.normalized)) continue
      issues.push({
        field: link.field,
        message: `${link.field} (${link.normalized}) conflicts with write target ${target.field} (${target.normalized}); a symlink must not be the target or an ancestor of a write`,
      })
    }
  }

  // Nested link targets are also impossible to create safely: creating the
  // parent link redirects the child operation into the source tree.
  for (let i = 0; i < links.length; i++) {
    for (let j = i + 1; j < links.length; j++) {
      const a = links[i]
      const b = links[j]
      if (isSameOrDescendant(a.normalized, b.normalized)) {
        issues.push({
          field: b.field,
          message: `${a.field} (${a.normalized}) is an ancestor of ${b.field} (${b.normalized})`,
        })
      } else if (isSameOrDescendant(b.normalized, a.normalized)) {
        issues.push({
          field: a.field,
          message: `${b.field} (${b.normalized}) is an ancestor of ${a.field} (${a.normalized})`,
        })
      }
    }
  }

  return issues
}
