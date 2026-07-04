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
    | "unsupported-compose-port"
    | "unresolved-port-variable"
    | "compose-project-name-env"
    | "compose-file-env"
    | "compose-override-file"
    | "fixed-volume-name"
    | "fixed-network-name"
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
  /** top-level `name:` の per-worktree 書き換えが create で実際に走るか (isolate_name && compose 設定済み) */
  identityRewriteEnabled: boolean
  /** container_name の per-worktree 書き換えが走るか (container_name !== 'keep' && compose 設定済み) */
  containerNameRewriteEnabled: boolean
  /** compose の `${VAR:-default}` 形式ポート伝播が走るか (propagation.enabled && compose && 設定済み) */
  composePortPropagationEnabled: boolean
  /** env ファイルのポート伝播が走るか (propagation.enabled) */
  envPortPropagationEnabled: boolean
}

export function analyzeRelocatability(input: {
  compose: ComposeConfig | null
  composeFile: string | null
  envMap: Record<string, string>
  config: WtbConfig
  options: AnalyzeOptions
  /** docker が自動マージする override ファイル (docker-compose.override.yml 等) の相対名。caller が I/O で発見して渡す。 */
  overrideFiles?: string[]
}): RelocatabilityReport {
  const { compose, composeFile, envMap, config, options, overrideFiles = [] } = input
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
        : "Set docker_compose_file and enable compose.isolate_name in wtb.yaml so wtb rewrites it, or remove the top-level name: from your compose file",
    })
  }

  // (b) container-name
  const servicesWithContainerName = Object.entries(compose.services ?? {})
    .filter(([, svc]) => svc.container_name)
    .map(([name]) => name)
  if (servicesWithContainerName.length > 0) {
    // container_name の書き換えは compose.container_name (suffix/strip/keep) で決まる。
    // isolate_name ではなくこのモードで判定する ('keep' や compose 未設定なら書き換えない)。
    const sev: FindingSeverity = options.containerNameRewriteEnabled ? "info" : "warning"
    const count = servicesWithContainerName.length
    findings.push({
      id: "container-name",
      severity: sev,
      message: options.containerNameRewriteEnabled
        ? `${count} service(s) have container_name (${servicesWithContainerName.join(", ")}); wtb rewrites container names per worktree`
        : `${count} service(s) have container_name (${servicesWithContainerName.join(", ")}); multiple worktrees will conflict on these fixed names`,
      suggestion: options.containerNameRewriteEnabled
        ? undefined
        : "Set compose.container_name to 'strip' or 'suffix' in wtb.yaml (and set docker_compose_file so wtb rewrites the file), or remove container_name from your services",
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
          // 常に warning。compose ポート伝播は `${VAR:-default}` 形式しか書き換えない
          // (リテラル `host:container` は対象外)。adjustPortsInCompose は稼働中コンテナと
          // 衝突したときだけ bump し、env の採番とは連動しないので「env に追従する」保証はない。
          findings.push({
            id: "literal-compose-port",
            severity: "warning",
            service: svcName,
            message: `Service '${svcName}' publishes host port ${mapping.hostPort} literally; wtb bumps ${envKey} but this literal mapping won't follow (port propagation only rewrites \${VAR}-form mappings)`,
            suggestion: `Use '\${${envKey}:-${mapping.hostPort}}:${mapping.containerPort}' in your compose ports`,
          })
        } else if (!mapping && /\d-\d/.test(raw)) {
          // range ("8000-8010:8000-8010") は adjustPortsInCompose も伝播もそのまま素通しする
          // ので、worktree 間で同一ポートを公開して衝突しうる。静的に警告する。
          // (bare "3000" のような ephemeral host port は衝突しないので対象外。)
          findings.push({
            id: "unsupported-compose-port",
            severity: "warning",
            service: svcName,
            message: `Service '${svcName}' has a port mapping '${raw}' wtb can't parse (port range or long-form); it is left as-is and will be identical across worktrees, so two stacks may collide on it`,
            suggestion:
              // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR:-port} shown as advice text
              "Use short 'HOST:CONTAINER' form with a '${VAR:-port}' host port so wtb can bump it per worktree",
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

  // (c') literal-env-port: env keys NOT in adjust whose value embeds an adjusted port.
  // 境界は「直前が `:`」に限定する (旧実装の `^` 先頭一致は TIMEOUT_MS=3000 のような
  // 非ポート値まで拾う偽陽性だった)。これは env ポート伝播が実際に書き換える形と一致する。
  const adjustKeySet = new Set(Object.keys(config.env.adjust ?? {}))
  for (const [envKey, envVal] of Object.entries(envMap)) {
    if (adjustKeySet.has(envKey)) continue
    for (const [port] of adjustedPorts) {
      const portStr = String(port)
      const boundaryRe = new RegExp(`:${portStr}(?:[^0-9]|$)`)
      if (boundaryRe.test(envVal)) {
        // env ポート伝播が有効なら、この埋め込みポートは実際に書き換えられる (= handled)。
        // 無効なら追従しないので警告する。
        findings.push({
          id: "literal-env-port",
          severity: options.envPortPropagationEnabled ? "info" : "warning",
          variable: envKey,
          message: options.envPortPropagationEnabled
            ? `Env var ${envKey}='${envVal}' embeds adjusted port ${portStr}; port propagation will update it per worktree`
            : `Env var ${envKey}='${envVal}' embeds adjusted port ${portStr}; port propagation is disabled so it won't be updated when wtb bumps ports`,
          suggestion: options.envPortPropagationEnabled
            ? undefined
            : "Enable env.port_propagation in wtb.yaml, or reference the port env var directly",
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

  // compose-file-env: COMPOSE_FILE は docker が読み込む compose ファイルを差し替えるが、
  // wtb は config.docker_compose_file しか書き換えないので、指したファイルが未分離になる。
  const composeFileEnv = process.env.COMPOSE_FILE
  if (composeFileEnv && composeFileEnv.trim() !== "") {
    findings.push({
      id: "compose-file-env",
      severity: "warning",
      message: `COMPOSE_FILE='${composeFileEnv}' changes which compose file(s) docker loads; wtb only rewrites docker_compose_file, so any other file it points to is not isolated`,
      suggestion: "Unset COMPOSE_FILE, or point docker_compose_file at the same file wtb should rewrite",
    })
  }

  // compose-override-file: docker compose は docker-compose.override.yml 等を自動マージするが
  // wtb は書き換えない。そこに固定 container_name/ports があると分離が黙って破れる。
  for (const overrideFile of overrideFiles) {
    findings.push({
      id: "compose-override-file",
      severity: "warning",
      message: `Compose override file '${overrideFile}' is auto-merged by 'docker compose' but wtb does not rewrite it; fixed container_name or ports there will break per-worktree isolation`,
      suggestion: `Fold the overrides into ${config.docker_compose_file || "your compose file"}, or avoid fixed names/ports in the override`,
    })
  }

  // fixed-volume-name / fixed-network-name: 非 external で明示 `name:` を持つ volume/network は
  // project 名を書き換えても同じ実体名になり、worktree 間で共有される (data / DNS の非分離)。
  const namedResources = (
    section: Record<string, unknown> | undefined
  ): Array<{ key: string; name: string }> => {
    const out: Array<{ key: string; name: string }> = []
    for (const [key, def] of Object.entries(section ?? {})) {
      if (!def || typeof def !== "object") continue
      const d = def as { name?: unknown; external?: unknown }
      if (d.external) continue
      if (typeof d.name === "string" && d.name.trim() !== "") out.push({ key, name: d.name })
    }
    return out
  }
  for (const { key, name } of namedResources(
    (compose as { volumes?: Record<string, unknown> }).volumes
  )) {
    findings.push({
      id: "fixed-volume-name",
      severity: "warning",
      message: `Volume '${key}' has a fixed name '${name}'; every worktree mounts the same volume, so data is NOT isolated (and wtb won't clone it)`,
      suggestion: `Remove the explicit name: from volume '${key}' so Compose namespaces it per project`,
    })
  }
  for (const { key, name } of namedResources(
    (compose as { networks?: Record<string, unknown> }).networks
  )) {
    findings.push({
      id: "fixed-network-name",
      severity: "info",
      message: `Network '${key}' has a fixed name '${name}'; worktrees will share this network`,
      suggestion: `Remove the explicit name: from network '${key}' if you want per-worktree network isolation`,
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
