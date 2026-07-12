/**
 * @fileoverview `wtb ports` コマンド実装
 * 各worktreeの adjusted 済ポート値・compose サービスポート・推定エンドポイントを出力する
 */

import * as path from "node:path"
import { Command, Option } from "commander"
import { EXIT_CODES } from "../../constants/index.js"
import { loadConfig } from "../../core/config/loader.js"
import { interpolateComposeValue } from "../../core/docker/interpolation.js"
import { parsePortMapping, readComposeFile } from "../../core/docker/compose.js"
import { resolveComposePath } from "../../core/docker/locate.js"
import { buildWorktreeEnvMap } from "../../core/environment/env-map.js"
import { getRepositoryContext } from "../../core/git/repository.js"
import { listWorktrees } from "../../core/git/worktree.js"
import type {
  ComposeServicePorts,
  PortsCommandOptions,
  WorktreeInfo,
  WorktreePorts,
  WtbConfig,
} from "../../types/index.js"
import { CLIError, getErrorMessage } from "../../utils/error.js"
import { withErrorHandling } from "../utils/command-helpers.js"
import { renderPortsJson, renderPortsPretty } from "../utils/ports-render.js"

/**
 * portsコマンドを作成
 */
export function portsCommand(): Command {
  return new Command("ports")
    .description("Print the adjusted ports and endpoints for this (or all) worktree(s)")
    .argument(
      "[branch]",
      "Branch whose worktree to print ports for (default: the current worktree)"
    )
    .option("-a, --all", "Output an array of all worktrees (default: current worktree only)")
    .option("--pretty", "Human-readable table instead of JSON")
    .addOption(
      new Option("--json", "JSON output (default; accepted for consistency)").conflicts("pretty")
    )
    .action(withErrorHandling(executePortsCommand))
}

async function executePortsCommand(
  branch: string | undefined,
  options: PortsCommandOptions
): Promise<void> {
  if (branch && options.all) {
    throw new CLIError(
      "Cannot combine a branch argument with --all — pass one or the other.",
      EXIT_CODES.INVALID_USAGE
    )
  }

  const repository = getRepositoryContext()
  const gitRoot = repository.mainRoot
  const config = loadConfig(gitRoot)
  const worktrees = listWorktrees(gitRoot)
  const currentPath = repository.currentRoot

  if (branch) {
    // gatherPortsForWorktree は WorktreeInfo 全体を必要とするため、
    // getWorktreePath ではなく読み込み済みの worktrees から解決する。
    const target = worktrees.find((wt) => wt.branch === branch)
    if (!target) {
      // 一覧はエラー診断の一部なので stderr に出す (stdout を script 出力用に汚さない)。
      console.error("Available worktrees:")
      for (const wt of worktrees) {
        console.error(`  ${wt.branch}: ${wt.path}`)
      }
      throw new CLIError(`No worktree found for branch '${branch}'`, EXIT_CODES.GENERAL_ERROR)
    }
    const row = gatherPortsForWorktree(target, gitRoot, config)
    if (options.pretty) {
      process.stdout.write(renderPortsPretty([row]))
    } else {
      process.stdout.write(`${renderPortsJson(row)}\n`)
    }
    return
  }

  if (options.all) {
    const rows = worktrees.map((wt) => gatherPortsForWorktree(wt, gitRoot, config))
    if (options.pretty) {
      process.stdout.write(renderPortsPretty(rows))
    } else {
      process.stdout.write(`${renderPortsJson(rows)}\n`)
    }
    return
  }

  const target = pickCurrentWorktree(worktrees, currentPath, gitRoot)
  if (!target) {
    throw new CLIError(
      "Could not determine current worktree (no matching path in `git worktree list`)",
      EXIT_CODES.GENERAL_ERROR
    )
  }
  const row = gatherPortsForWorktree(target, gitRoot, config)
  if (options.pretty) {
    process.stdout.write(renderPortsPretty([row]))
  } else {
    process.stdout.write(`${renderPortsJson(row)}\n`)
  }
}

/**
 * cwd を含む worktree を選ぶ。該当なしなら main(gitRoot と同じ path)へフォールバック。
 */
function pickCurrentWorktree(
  worktrees: WorktreeInfo[],
  currentPath: string,
  gitRoot: string
): WorktreeInfo | null {
  const resolvedCwd = path.resolve(currentPath)
  const exact = worktrees.find((wt) => path.resolve(wt.path) === resolvedCwd)
  if (exact) return exact

  // For callers that pass a nested directory, choose the deepest containing
  // worktree. The main worktree may itself be an ancestor of a manually placed
  // linked worktree, so first-match order is not safe.
  const byCwd = worktrees
    .filter((wt) => {
    const resolved = path.resolve(wt.path)
      return resolvedCwd.startsWith(`${resolved}${path.sep}`)
    })
    .sort((a, b) => path.resolve(b.path).length - path.resolve(a.path).length)[0]
  if (byCwd) return byCwd
  return worktrees.find((wt) => path.resolve(wt.path) === path.resolve(gitRoot)) ?? null
}

/**
 * 1 worktree 分の ports 情報を収集する。
 * - env: config.env.adjust の key のみ、対応 worktree の env ファイルから値を引く
 * - compose: config.docker_compose_file または findComposeFile で見つけた compose から抽出
 * - endpoints: compose の host_ports を http://localhost:<port> に単純展開
 */
export function gatherPortsForWorktree(
  wt: WorktreeInfo,
  gitRoot: string,
  config: WtbConfig
): WorktreePorts {
  const worktreePath = path.resolve(wt.path)

  const envMap = buildWorktreeEnvMap(worktreePath, config)
  const env = collectEnvValues(envMap, config)
  const compose = collectComposeServices(worktreePath, gitRoot, config, envMap)
  const endpoints = buildEndpoints(compose.services)

  return {
    path: worktreePath,
    branch: wt.branch,
    env,
    compose,
    endpoints,
  }
}

function collectEnvValues(
  envMap: Record<string, string>,
  config: WtbConfig
): Record<string, string> {
  const adjustKeys = new Set(Object.keys(config.env.adjust ?? {}))
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(envMap)) {
    if (adjustKeys.has(key)) out[key] = value
  }
  return out
}

function collectComposeServices(
  worktreePath: string,
  gitRoot: string,
  config: WtbConfig,
  envMap: Record<string, string>
): WorktreePorts["compose"] {
  const composePath = resolveComposePath(worktreePath, gitRoot, config)
  if (!composePath) {
    return { file: null, services: {} }
  }

  try {
    const parsed = readComposeFile(composePath)
    const services: Record<string, ComposeServicePorts> = {}
    const warnedVars = new Set<string>()

    for (const [name, svc] of Object.entries(parsed.services ?? {})) {
      const hostPorts: number[] = []
      const containerPorts: number[] = []
      if (svc.ports && Array.isArray(svc.ports)) {
        for (const entry of svc.ports) {
          if (typeof entry === "string" || typeof entry === "number") {
            const raw = String(entry)
            const r = interpolateComposeValue(raw, envMap)
            if (r.unresolved.length > 0) {
              for (const varName of r.unresolved) {
                const warnKey = `${name}:${varName}`
                if (!warnedVars.has(warnKey)) {
                  warnedVars.add(warnKey)
                  process.stderr.write(
                    `⚠️  ports: skipping port for service '${name}' — unresolved variable(s): ${varName} (no env value, no compose default)\n`
                  )
                }
              }
              continue
            }
            const mapping = parsePortMapping(r.value)
            if (!mapping) {
              if (r.value !== raw) {
                process.stderr.write(
                  `⚠️  ports: service '${name}' — resolved to non-port value '${r.value}'\n`
                )
              }
              continue
            }
            hostPorts.push(mapping.hostPort)
            containerPorts.push(mapping.containerPort)
          } else if (entry !== null && typeof entry === "object") {
            const { target, published } = entry as {
              target?: number | string
              published?: number | string
              protocol?: string
              mode?: string
            }
            if (published === undefined || published === null) continue
            const pubStr = String(published)
            if (pubStr.includes("-") && !pubStr.startsWith("${")) continue
            const pubR = interpolateComposeValue(pubStr, envMap)
            if (pubR.unresolved.length > 0) {
              for (const varName of pubR.unresolved) {
                const warnKey = `${name}:${varName}`
                if (!warnedVars.has(warnKey)) {
                  warnedVars.add(warnKey)
                  process.stderr.write(
                    `⚠️  ports: skipping port for service '${name}' — unresolved variable(s): ${varName} (no env value, no compose default)\n`
                  )
                }
              }
              continue
            }
            const hostPort = Number.parseInt(pubR.value, 10)
            if (!Number.isFinite(hostPort) || hostPort < 1 || hostPort > 65535) continue
            const tgtStr = target !== undefined ? String(target) : ""
            const tgtR = tgtStr
              ? interpolateComposeValue(tgtStr, envMap)
              : { value: "", unresolved: [] }
            const containerPort = tgtStr ? Number.parseInt(tgtR.value, 10) : hostPort
            if (!Number.isFinite(containerPort) || containerPort < 1 || containerPort > 65535)
              continue
            hostPorts.push(hostPort)
            containerPorts.push(containerPort)
          }
        }
      }
      services[name] = { host_ports: hostPorts, container_ports: containerPorts }
    }
    return {
      file: path.relative(worktreePath, composePath) || path.basename(composePath),
      services,
    }
  } catch (error) {
    process.stderr.write(
      `⚠️  Failed to read compose file at ${composePath}: ${getErrorMessage(error)}\n`
    )
    return { file: null, services: {} }
  }
}

function buildEndpoints(services: Record<string, ComposeServicePorts>): string[] {
  const seen = new Set<number>()
  const out: string[] = []
  for (const svc of Object.values(services)) {
    for (const p of svc.host_ports) {
      if (!seen.has(p)) {
        seen.add(p)
        out.push(`http://localhost:${p}`)
      }
    }
  }
  return out
}
