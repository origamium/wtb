/**
 * @fileoverview Relocatability analysis — pure, no I/O (caller passes parsed compose + envMap)
 */
import { containsVariableReference, interpolateComposeValue } from "./interpolation.js"
import { parsePortMapping } from "./compose.js"
import type { ComposeConfig, WtbConfig } from "../../types/index.js"

export type FindingSeverity = "info" | "warning" | "error"

export interface RelocatabilityFinding {
  id:
    | "fixed-project-name"
    | "container-name"
    | "literal-env-port"
    | "literal-compose-port"
    | "unresolved-port-variable"
    | "compose-project-name-env"
    | "no-compose-file"
  severity: FindingSeverity
  message: string
  suggestion?: string
  service?: string
  variable?: string
}

export interface RelocatabilityReport {
  composeFile: string | null
  findings: RelocatabilityFinding[]
  summary: { info: number; warning: number; error: number }
  ok: boolean
}

export interface AnalyzeOptions {
  identityRewriteEnabled: boolean
  portPropagationEnabled: boolean
}

export function analyzeRelocatability(input: {
  compose: ComposeConfig | null
  composeFile: string | null
  envMap: Record<string, string>
  config: WtbConfig
  options: AnalyzeOptions
}): RelocatabilityReport {
  const { compose, composeFile, envMap, config, options } = input
  const findings: RelocatabilityFinding[] = []

  if (compose === null) {
    findings.push({
      id: "no-compose-file",
      severity: "info",
      message: "No compose file found — relocatability checks skipped",
    })
    return buildReport(composeFile, findings)
  }

  // (a) fixed-project-name
  if (compose.name && typeof compose.name === "string" && compose.name.trim() !== "") {
    const sev: FindingSeverity = options.identityRewriteEnabled ? "info" : "warning"
    findings.push({
      id: "fixed-project-name",
      severity: sev,
      message: options.identityRewriteEnabled
        ? `Compose file has a fixed project name '${compose.name}'; wtb rewrites the project identity per worktree, so this is handled`
        : `All worktrees share Compose project '${compose.name}'; a 2nd wtb create will attach to/clobber the first stack`,
      suggestion: options.identityRewriteEnabled
        ? undefined
        : "Enable compose.isolate_name in wtb.yaml, or remove the top-level name: from your compose file",
    })
  }

  // (b) container-name
  const servicesWithContainerName = Object.entries(compose.services ?? {})
    .filter(([, svc]) => svc.container_name)
    .map(([name]) => name)
  if (servicesWithContainerName.length > 0) {
    const sev: FindingSeverity = options.identityRewriteEnabled ? "info" : "warning"
    const count = servicesWithContainerName.length
    findings.push({
      id: "container-name",
      severity: sev,
      message: options.identityRewriteEnabled
        ? `${count} service(s) have container_name (${servicesWithContainerName.join(", ")}); wtb rewrites container names per worktree`
        : `${count} service(s) have container_name (${servicesWithContainerName.join(", ")}); multiple worktrees will conflict`,
      suggestion: options.identityRewriteEnabled
        ? undefined
        : "Set compose.container_name to 'strip' or 'suffix' in wtb.yaml, or remove container_name from your services",
    })
  }

  // Build adjustedPorts map: port number → envKey (only numeric-marker adjust keys)
  const adjustedPorts = new Map<number, string>()
  for (const [envKey, marker] of Object.entries(config.env.adjust ?? {})) {
    if (typeof marker === "number") {
      const currentVal = envMap[envKey]
      if (currentVal !== undefined) {
        const p = Number.parseInt(currentVal, 10)
        if (Number.isFinite(p)) adjustedPorts.set(p, envKey)
      }
    }
  }

  // (c) literal-compose-port + (d) unresolved-port-variable
  for (const [svcName, svc] of Object.entries(compose.services ?? {})) {
    for (const entry of svc.ports ?? []) {
      if (typeof entry !== "string" && typeof entry !== "number") continue
      const raw = String(entry)

      if (!containsVariableReference(raw)) {
        // Literal port — check if it's an adjusted port
        const mapping = parsePortMapping(raw)
        if (mapping && adjustedPorts.has(mapping.hostPort)) {
          // biome-ignore lint/style/noNonNullAssertion: has() guard above ensures the value exists
          const envKey = adjustedPorts.get(mapping.hostPort)!
          const sev: FindingSeverity = options.portPropagationEnabled ? "info" : "warning"
          findings.push({
            id: "literal-compose-port",
            severity: sev,
            service: svcName,
            message: options.portPropagationEnabled
              ? `Service '${svcName}' publishes host port ${mapping.hostPort} literally; port propagation is enabled and will rewrite this mapping per worktree`
              : `Service '${svcName}' publishes host port ${mapping.hostPort} literally; wtb bumps ${envKey} but this mapping won't follow`,
            suggestion: `Use '\${${envKey}:-${mapping.hostPort}}:${mapping.containerPort}' in your compose ports`,
          })
        }
      } else {
        // Variable ref — check if unresolved
        const r = interpolateComposeValue(raw, envMap)
        if (r.unresolved.length > 0) {
          for (const varName of r.unresolved) {
            findings.push({
              id: "unresolved-port-variable",
              severity: "warning",
              service: svcName,
              variable: varName,
              message: `Service '${svcName}' has an unresolved port variable \${${varName}} — no env value and no compose default`,
              suggestion: `Set ${varName} in your env file or add a default: \${${varName}:-<port>}`,
            })
          }
        }
      }
    }
  }

  // (c') literal-env-port: env keys NOT in adjust whose value embeds an adjusted port
  const adjustKeySet = new Set(Object.keys(config.env.adjust ?? {}))
  for (const [envKey, envVal] of Object.entries(envMap)) {
    if (adjustKeySet.has(envKey)) continue
    for (const [port] of adjustedPorts) {
      const portStr = String(port)
      const boundaryRe = new RegExp(
        `(?:^|:|localhost:|127\\.0\\.0\\.1:)${portStr}(?:[^0-9]|$)`
      )
      if (boundaryRe.test(envVal)) {
        findings.push({
          id: "literal-env-port",
          severity: "info",
          variable: envKey,
          message: `Env var ${envKey}='${envVal}' appears to embed adjusted port ${portStr}; it won't be updated when wtb bumps ports`,
          suggestion: "If this value needs the port, reference the port env var directly",
        })
        break // one finding per env key
      }
    }
  }

  // compose-project-name-env
  const composeProjectNameEnv = process.env.COMPOSE_PROJECT_NAME
  if (composeProjectNameEnv && composeProjectNameEnv.trim() !== "") {
    findings.push({
      id: "compose-project-name-env",
      severity: "warning",
      message: `COMPOSE_PROJECT_NAME='${composeProjectNameEnv}' overrides per-worktree identity; wtb cannot isolate while it is set`,
      suggestion: "Unset COMPOSE_PROJECT_NAME from your shell environment",
    })
  }

  return buildReport(composeFile, findings)
}

function buildReport(
  composeFile: string | null,
  findings: RelocatabilityFinding[]
): RelocatabilityReport {
  const summary = { info: 0, warning: 0, error: 0 }
  for (const f of findings) summary[f.severity]++
  const ok = summary.warning === 0 && summary.error === 0
  return { composeFile, findings, summary, ok }
}
