import * as fs from "node:fs"
import * as path from "node:path"
import { type Document, isMap, isScalar, parseDocument } from "yaml"
import { getRepositoryContext, withRepositoryLock } from "../../core/git/repository.js"
import { atomicWriteFileSync } from "../../utils/atomic-file.js"
import { CLIError } from "../../utils/error.js"

export interface OrcaInstallOptions {
  force?: boolean
  removeVolumes?: boolean
  check?: boolean
  dryRun?: boolean
}

export interface OrcaInstallResult {
  path: string
  existed: boolean
  changed: boolean
  wrote: boolean
  check: boolean
  dryRun: boolean
  removeVolumes: boolean
  differences: string[]
  ok: boolean
}

export const ORCA_SETUP_COMMAND = "wtb setup --up --wait --timeout 120 --json"

export function orcaHookCommands(removeVolumes = false): Record<string, string> {
  return {
    "scripts.setup": ORCA_SETUP_COMMAND,
    "scripts.archive": `wtb teardown${removeVolumes ? " --remove-volumes" : ""} --json`,
    setupAgentStartupPolicy: "wait-for-setup",
  }
}

/** Only accept an Orca root that is itself a checkout of the caller's repository. */
export function resolveOrcaRoot(cwd: string, orcaRoot?: string): string {
  const context = getRepositoryContext(cwd)
  if (orcaRoot === undefined) return context.mainRoot
  if (!path.isAbsolute(orcaRoot)) {
    throw new CLIError("ORCA_ROOT_PATH must be an absolute repository root", 1)
  }
  let candidate: ReturnType<typeof getRepositoryContext>
  let canonical: string
  try {
    canonical = fs.realpathSync(orcaRoot)
    candidate = getRepositoryContext(canonical)
  } catch {
    throw new CLIError("ORCA_ROOT_PATH is not an accessible Git checkout", 1)
  }
  if (canonical !== candidate.currentRoot || candidate.commonGitDir !== context.commonGitDir) {
    throw new CLIError("ORCA_ROOT_PATH must name a worktree root of this Git repository", 1)
  }
  return canonical
}

function readConfiguration(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new CLIError(`Refusing non-regular or symlinked Orca config: ${file}`, 1)
    }
    return fs.readFileSync(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/** Preserve comments and every key outside the three integration-owned keys. */
export function mergeOrcaConfiguration(content: string | undefined, options: OrcaInstallOptions) {
  const document: Document = parseDocument(content ?? "", { uniqueKeys: true })
  if (document.errors.length > 0 || (document.contents !== null && !isMap(document.contents))) {
    throw new CLIError("orca.yaml must contain one valid YAML mapping; it was not changed", 4)
  }
  if (document.contents === null) document.contents = document.createNode({})
  const scripts = document.get("scripts", true)
  if (scripts !== undefined && !isMap(scripts)) {
    throw new CLIError("orca.yaml scripts must be a mapping (aliases are not modified)", 4)
  }
  if (isMap(scripts) && scripts.anchor) {
    throw new CLIError(
      "orca.yaml scripts must not be anchored; changing it could change other settings",
      4
    )
  }
  const differences: string[] = []
  const conflicts: string[] = []
  for (const [key, value] of Object.entries(orcaHookCommands(options.removeVolumes))) {
    const keys = key.split(".")
    const node = document.getIn(keys, true)
    if (isScalar(node) && node.value === value) continue
    if (isScalar(node) && node.anchor) {
      throw new CLIError(
        `orca.yaml ${key} must not be anchored; changing it could change other settings`,
        4
      )
    }
    differences.push(key)
    if (node !== undefined) conflicts.push(key)
    if (isScalar(node)) node.value = value
    else document.setIn(keys, value)
  }
  if (conflicts.length > 0 && !options.force && !options.check) {
    throw new CLIError(
      `Orca integration conflicts at ${conflicts.join(", ")}; review the existing hooks and use --force to replace only these keys`,
      1
    )
  }
  return { content: differences.length === 0 ? (content ?? "") : document.toString(), differences }
}

/** Configure shared hooks only; never call Orca or modify Orca's local settings. */
export async function installOrcaHooks(
  options: OrcaInstallOptions,
  cwd = process.cwd(),
  orcaRoot = process.env.ORCA_ROOT_PATH
): Promise<OrcaInstallResult> {
  const root = resolveOrcaRoot(cwd, orcaRoot)
  const file = path.join(root, "orca.yaml")
  const operation = (): OrcaInstallResult => {
    if (resolveOrcaRoot(cwd, orcaRoot) !== root) {
      throw new CLIError("Orca repository root changed during installation", 1)
    }
    const previous = readConfiguration(file)
    const merged = mergeOrcaConfiguration(previous, options)
    const changed = merged.differences.length > 0
    const wrote = changed && !options.check && !options.dryRun
    if (wrote) {
      if (readConfiguration(file) !== previous) {
        throw new CLIError("orca.yaml changed during installation; retry after reviewing it", 1)
      }
      atomicWriteFileSync(file, merged.content)
    }
    return {
      path: file,
      existed: previous !== undefined,
      changed,
      wrote,
      check: !!options.check,
      dryRun: !!options.dryRun,
      removeVolumes: !!options.removeVolumes,
      differences: merged.differences,
      ok: !options.check || !changed,
    }
  }
  if (options.check || options.dryRun) return operation()
  return withRepositoryLock(getRepositoryContext(cwd), operation)
}
