/**
 * @fileoverview Docker Compose ファイル操作
 * Docker Composeファイルの読み込み、書き込み、ポート調整を担当
 */

import { createHash, randomUUID } from "node:crypto"
import { existsSync, unlinkSync } from "node:fs"
import * as path from "node:path"
import fs from "fs-extra"
import { parse, parseDocument, stringify, visit } from "yaml"
import {
  COMPOSE_FILE_NAMES,
  FILE_ENCODING,
  MAX_TCP_PORT,
  PORT_RANGE,
} from "../../constants/index.js"
import type { ComposeConfig, FileOperationOptions } from "../../types/index.js"
import { atomicWriteFileSync } from "../../utils/atomic-file.js"
import { execDockerSafe } from "../../utils/exec.js"
import { out } from "../../utils/output.js"
import { parseEnvContent } from "../environment/processor.js"
import {
  type PortMap,
  propagateComposeDefaults,
  propagatePortsInValue,
} from "../environment/propagate.js"
import { containsVariableReference, interpolateComposeValue } from "./interpolation.js"

/**
 * Docker Composeファイルを読み込んでパース
 *
 * @param filePath - Composeファイルのパス
 * @param options - ファイル操作オプション
 * @returns パースされた設定オブジェクト
 * @throws {Error} ファイルの読み込みまたはパースに失敗した場合
 *
 * @example
 * ```typescript
 * try {
 *   const config = readComposeFile('./docker-compose.yml')
 *   console.log(`Services: ${Object.keys(config.services).length}`)
 * } catch (error) {
 *   console.error('Failed to read compose file:', error.message)
 * }
 * ```
 */
export function readComposeFile(filePath: string, options?: FileOperationOptions): ComposeConfig {
  try {
    if (!existsSync(filePath)) {
      throw new Error(`Docker Compose file not found: ${filePath}`)
    }

    const content = fs.readFileSync(filePath, {
      encoding: options?.encoding || FILE_ENCODING,
    })

    // merge: true で YAML merge key (`<<: *anchor`) を解決する。解決しないと anchor 内の
    // ports / container_name が service に現れず (service.ports === undefined)、identity
    // 書き換え・ポート調整・伝播が全て素通りして worktree 間で同一ポートが公開される。
    const parsed = parse(content, { merge: true }) as ComposeConfig

    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid Docker Compose file format")
    }

    if (!parsed.services || typeof parsed.services !== "object") {
      throw new Error("Docker Compose file must contain a services section")
    }

    // wtb transforms and ownership-checks one self-contained Compose model. The
    // Compose CLI resolves `include` and service `extends` from additional files;
    // silently ignoring them would leave ports/identity/volumes unisolated and
    // could let `down -v` delete data that never passed our ownership checks.
    if ((parsed as { include?: unknown }).include !== undefined) {
      throw new Error(
        "Docker Compose include is not supported safely; merge the included file into docker_compose_file"
      )
    }
    const extendedServices = Object.entries(parsed.services)
      .filter(([, service]) => service && typeof service === "object" && "extends" in service)
      .map(([serviceName]) => serviceName)
    if (extendedServices.length > 0) {
      throw new Error(
        `Docker Compose service extends is not supported safely (services: ${extendedServices.join(", ")}); inline the inherited service definitions`
      )
    }
    assertComposeStorageDefinitionsSafe(parsed)

    return parsed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("not found")) {
      throw error
    }
    throw new Error(`Failed to parse Docker Compose file: ${message}`)
  }
}

/**
 * Validate storage/network declarations whose backing resource would escape
 * Compose's per-project namespace. Explicit sharing is only accepted through
 * `external`, where Compose also guarantees `down -v` will not delete it.
 */
export function assertComposeStorageDefinitionsSafe(config: ComposeConfig): void {
  const volumesFromServices = Object.entries(config.services ?? {})
    .filter(([, service]) => service?.volumes_from !== undefined)
    .map(([serviceName]) => serviceName)
  if (volumesFromServices.length > 0) {
    throw new Error(
      `Docker Compose volumes_from is not supported safely (services: ${volumesFromServices.join(", ")}); declare per-project named volumes explicitly instead`
    )
  }

  for (const [key, rawEntry] of Object.entries(config.volumes ?? {})) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue
    const entry = rawEntry as Record<string, unknown>
    if (isExternalResourceEntry(entry)) continue
    if (typeof entry.name === "string" && entry.name.length > 0) {
      throw new Error(
        `Non-external volume '${key}' has an explicit name; remove name for per-project isolation or mark it external for intentional sharing`
      )
    }
    if (typeof entry.driver === "string" && entry.driver !== "local") {
      throw new Error(
        `Non-external volume '${key}' uses driver '${entry.driver}', whose backing data wtb cannot prove is isolated`
      )
    }
    if (
      entry.driver_opts !== undefined &&
      (typeof entry.driver_opts !== "object" ||
        entry.driver_opts === null ||
        Object.keys(entry.driver_opts as Record<string, unknown>).length > 0)
    ) {
      throw new Error(
        `Non-external volume '${key}' uses driver_opts, whose backing data wtb cannot prove is isolated`
      )
    }
  }

  for (const [key, rawEntry] of Object.entries(config.networks ?? {})) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue
    const entry = rawEntry as Record<string, unknown>
    if (isExternalResourceEntry(entry)) continue
    if (typeof entry.name === "string" && entry.name.length > 0) {
      throw new Error(
        `Non-external network '${key}' has an explicit name; remove name for per-project isolation or mark it external for intentional sharing`
      )
    }
  }
}

function isExternalResourceEntry(entry: Record<string, unknown>): boolean {
  return entry.external === true || (entry.external !== null && typeof entry.external === "object")
}

/**
 * Docker Compose設定をファイルに書き込み
 *
 * @param filePath - 出力先ファイルパス
 * @param config - 書き込む設定オブジェクト
 * @param options - ファイル操作オプション
 * @throws {Error} ファイルの書き込みに失敗した場合
 *
 * @example
 * ```typescript
 * const config = {
 *   version: '3.8',
 *   services: {
 *     web: { image: 'nginx', ports: ['8080:80'] }
 *   }
 * }
 * writeComposeFile('./docker-compose.new.yml', config)
 * ```
 */
export function writeComposeFile(
  filePath: string,
  config: ComposeConfig,
  options?: FileOperationOptions
): void {
  try {
    // バックアップ作成（オプション）
    if (options?.createBackup && existsSync(filePath)) {
      const backupPath = `${filePath}.backup`
      fs.copyFileSync(filePath, backupPath)
      out(`📋 Created backup: ${backupPath}`)
    }

    // YAML 1.1 danger set: strings that Docker's Go YAML 1.1 parser would
    // misinterpret as booleans, nulls, sexagesimal integers, or octal numbers.
    // We parse into a Document, visit all plain string scalars — mapping
    // VALUES and SEQUENCE items alike (mapping keys are excluded) — and
    // force double-quote on any that are in the danger set.
    const YAML11_DANGEROUS = /^(y|yes|n|no|true|false|on|off|null|~)$/i
    const SEXAGESIMAL = /^\d+(:\d+)+$/          // e.g. 00:00, 1:30:00
    const LEADING_ZERO_INT = /^0\d+$/            // e.g. 0755, 0123
    const PURE_NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/ // numeric strings

    function isDangerous(val: string): boolean {
      if (val === "") return true
      if (YAML11_DANGEROUS.test(val)) return true
      if (SEXAGESIMAL.test(val)) return true
      if (LEADING_ZERO_INT.test(val)) return true
      if (PURE_NUMBER.test(val)) return true
      return false
    }

    const doc = parseDocument(
      stringify(config, { indent: 2, lineWidth: 120, minContentWidth: 80 })
    )

    visit(doc, {
      Scalar(key, node) {
        if (key === "key") return // マッピングのキーはプレーンのまま
        if (node.type === "PLAIN" && typeof node.value === "string" && isDangerous(node.value)) {
          node.type = "QUOTE_DOUBLE"
        }
      },
    })

    const yamlContent = String(doc)

    atomicWriteFileSync(filePath, yamlContent, {
      encoding: options?.encoding || FILE_ENCODING,
    })

    out(`📄 Wrote Docker Compose file: ${filePath}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to write Docker Compose file: ${message}`)
  }
}

/**
 * Run Docker Compose against immutable, already-validated bytes rather than
 * re-opening a mutable worktree file after ownership checks. The snapshot is
 * placed beside the source so Compose-relative paths retain their directory.
 */
export function withComposeSnapshot<T>(
  sourceFilePath: string,
  config: ComposeConfig,
  operation: (snapshotPath: string) => T
): T {
  const snapshotPath = path.join(
    path.dirname(sourceFilePath),
    `.${path.basename(sourceFilePath)}.wtb-snapshot-${process.pid}-${randomUUID()}.yml`
  )
  writeComposeFile(snapshotPath, config)
  try {
    return operation(snapshotPath)
  } finally {
    unlinkSync(snapshotPath)
  }
}

/**
 * Docker Compose設定内で使用中のポートを避けて新しいポートに調整
 *
 * @param config - 調整する設定オブジェクト
 * @param usedPorts - 使用中のポート番号配列
 * @returns 調整された設定オブジェクト（元のオブジェクトは変更されない）
 *
 * @example
 * ```typescript
 * const config = {
 *   version: '3.8',
 *   services: {
 *     web: { image: 'nginx', ports: ['3000:80'] }
 *   }
 * }
 * const usedPorts = [3000, 3001]
 * const adjusted = adjustPortsInCompose(config, usedPorts)
 * // web.portsは['3002:80']に調整される
 * ```
 */
/**
 * Docker Compose のポートマッピング文字列を解析。
 * IPv4/IPv6 の host IP、単一 host/container port、protocol suffix に対応する。
 *
 * @returns { hostPort, containerPort } または null (解析不能)
 */
export function parsePortMapping(portMapping: string): {
  hostPort: number
  containerPort: number
  ip?: string
  proto?: string
} | null {
  if (typeof portMapping !== "string") return null

  const protocolMatch = portMapping.match(/^(.*?)(\/[A-Za-z][A-Za-z0-9]*)?$/)
  if (!protocolMatch) return null
  const mapping = protocolMatch[1]
  const proto = protocolMatch[2]

  // Parse from the right so both bracketed (`[::1]`) and Compose's accepted
  // unbracketed IPv6 host form (`::1`) retain every address colon.
  const simple = mapping.match(/^(\d+):(\d+)$/)
  const withHostIp = simple ? null : mapping.match(/^(.+):(\d+):(\d+)$/)
  if (!simple && !withHostIp) return null

  const hostPort = Number.parseInt(simple?.[1] ?? withHostIp?.[2] ?? "", 10)
  const containerPort = Number.parseInt(simple?.[2] ?? withHostIp?.[3] ?? "", 10)
  if (!isTcpPort(hostPort) || !isTcpPort(containerPort)) return null

  const hostIp = withHostIp?.[1]
  if (hostIp?.startsWith("[") !== hostIp?.endsWith("]")) return null
  return {
    hostPort,
    containerPort,
    ip: hostIp === undefined ? undefined : `${hostIp}:`,
    proto,
  }
}

export function adjustPortsInCompose(
  config: ComposeConfig,
  usedPorts: number[],
  isolatedPublishedVariables: ReadonlySet<string> = new Set()
): ComposeConfig {
  assertComposeNetworkingSafe(config)
  // 深いコピーを作成して元のオブジェクトを変更しない
  const newConfig = structuredClone(config) as ComposeConfig
  const currentlyUsed = [...usedPorts]

  Object.entries(newConfig.services).forEach(([serviceName, service]) => {
    if (service.ports && Array.isArray(service.ports)) {
      service.ports = service.ports.map((portMapping, index) => {
        if (typeof portMapping === "number") {
          // Container-only short syntax asks Docker to choose the host port.
          return portMapping
        }

        if (typeof portMapping === "string") {
          if (containsPortRange(portMapping)) {
            throw new Error(
              `Service '${serviceName}' ports[${index}] uses an unsupported port range: ${portMapping}`
            )
          }

          const parsed = parsePortMapping(portMapping)
          if (!parsed) {
            // Container-only declarations do not publish a fixed host port. An
            // omitted short-form host port (e.g. `127.0.0.1::80`) is likewise
            // delegated to Docker's dynamic allocator.
            if (
              /^\d+(?:\/[A-Za-z][A-Za-z0-9]*)?$/.test(portMapping) ||
              /^(?:\[[^\]]+\]|[^:]+)?::\d+(?:\/[A-Za-z][A-Za-z0-9]*)?$/.test(portMapping)
            ) {
              return portMapping
            }

            // A variable in the published (host) position is safe only when the
            // env phase allocated that variable from the same repository-wide
            // reservation set. Otherwise Compose will resolve a fixed port after
            // this pass and can silently collide with a sibling worktree.
            const variable = publishedVariableInShortMapping(portMapping)
            if (variable && isolatedPublishedVariables.has(variable)) {
              return portMapping
            }
            throw new Error(
              `Service '${serviceName}' ports[${index}] has an unsupported or unresolved published port: ${portMapping}`
            )
          }

          const newHostPort = findAvailablePort(parsed.hostPort, currentlyUsed)
          currentlyUsed.push(newHostPort)

          // Reconstruct from parsed components to avoid corrupting IP octets
          // that happen to contain the host-port digits.
          return `${parsed.ip ?? ""}${newHostPort}:${parsed.containerPort}${parsed.proto ?? ""}`
        }

        if (!portMapping || typeof portMapping !== "object") return portMapping

        const published = portMapping.published
        const target = portMapping.target
        if (
          (typeof published === "string" && containsPortRange(published)) ||
          (typeof target === "string" && containsPortRange(target))
        ) {
          throw new Error(
            `Service '${serviceName}' ports[${index}] uses an unsupported long-form port range`
          )
        }

        // Omitted/dynamic published ports are allocated by Docker and cannot
        // collide as a fixed declaration. Variable forms remain for Compose's
        // interpolation and are handled by env propagation.
        if (published === undefined) return portMapping
        const publishedPort = parseSinglePublishedPort(published)
        if (publishedPort === null) {
          if (
            typeof published === "string" &&
            publishedVariable(published) !== null &&
            isolatedPublishedVariables.has(publishedVariable(published) as string)
          ) {
            return portMapping
          }
          throw new Error(
            `Service '${serviceName}' ports[${index}] has an unsupported or unresolved long-form published port: ${String(published)}`
          )
        }

        const newHostPort = findAvailablePort(publishedPort, currentlyUsed)
        currentlyUsed.push(newHostPort)

        return {
          ...portMapping,
          published: typeof published === "number" ? newHostPort : String(newHostPort),
        }
      })
    }
  })

  return newConfig
}

/**
 * Reject networking modes whose host-port usage cannot be enumerated or whose
 * namespace belongs to a fixed external container. This must be applied both
 * to the target Compose and to every sibling used to build the reservation set.
 */
export function assertComposeNetworkingSafe(config: ComposeConfig): void {
  for (const [serviceName, service] of Object.entries(config.services ?? {})) {
    if (typeof service.network_mode !== "string") continue
    if (containsVariableReference(service.network_mode)) {
      throw new Error(
        `Service '${serviceName}' has a variable network_mode that may resolve to host or container networking and cannot be isolated safely`
      )
    }
    const mode = service.network_mode.trim().toLowerCase()
    if (mode === "host") {
      throw new Error(
        `Service '${serviceName}' uses network_mode: host; its host ports cannot be isolated per worktree`
      )
    }
    if (mode.startsWith("container:")) {
      throw new Error(
        `Service '${serviceName}' uses network_mode: container:..., which shares another container's network namespace and cannot be isolated per worktree`
      )
    }
  }
}

/** Extract a single Compose variable reference used as a scalar. */
function publishedVariable(raw: string): string | null {
  const match = raw.match(
    /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(?::-|-)[^}]*)?\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/
  )
  return match?.[1] ?? match?.[2] ?? null
}

/** Extract the variable occupying the host-published position in short syntax. */
function publishedVariableInShortMapping(raw: string): string | null {
  const withoutProtocol = raw.replace(/\/[A-Za-z][A-Za-z0-9]*$/, "")
  const match = withoutProtocol.match(
    /(?:^|:)(\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(?::-|-)[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)):\d+$/
  )
  return match?.[2] ?? match?.[3] ?? null
}

/**
 * propagatePortsInComposeValues が報告する 1 件の値変更。
 * location は `<service>.environment.<KEY>` または `<service>.ports[<index>]`。
 */
export interface ComposeValueChange {
  location: string
  from: string
  to: string
}

/**
 * Compose 設定の文字列値（各サービスの environment と ports）に env→compose の
 * ポート伝播を適用する純粋関数。元の config は変更せず clone を返す。
 *
 * 各文字列に対し propagateComposeDefaults（`${VAR:-default}` を解決）→
 * propagatePortsInValue（`:54321` 形式の裸ポート）を順に適用する。
 *
 * これは adjustPortsInCompose の前に実行することを想定している。
 * `${KONG_HTTP_PORT:-54321}:8000` のような mapping は parsePortMapping が
 * 解析できず adjustPortsInCompose では触れないため、ここでのみ修正される。
 *
 * @param envChanges - env var 名 → { from, to } のルックアップ（compose default 用）
 * @param map - original → new のポートマッピング（裸ポート用）
 * @returns 伝播後の config と、変更内訳の一覧
 */
export function propagatePortsInComposeValues(
  config: ComposeConfig,
  envChanges: Record<string, { from: string; to: string }>,
  map: PortMap
): { config: ComposeConfig; changes: ComposeValueChange[] } {
  const newConfig = structuredClone(config) as ComposeConfig
  const changes: ComposeValueChange[] = []

  // 1 つの文字列値に伝播を適用し、変わった場合だけ changes に記録して新値を返す。
  // ports パス → defaults パスの順で適用する。逆順だと defaults が env 由来の新ポートを
  // default に差し込んだ直後に ports パスがそれを再マップして二重ホップ (A→B→C) する。
  const rewrite = (raw: string, location: string): string => {
    const afterPorts = propagatePortsInValue(raw, map).value
    const afterDefaults = propagateComposeDefaults(afterPorts, envChanges, map)
    if (afterDefaults !== raw) {
      changes.push({ location, from: raw, to: afterDefaults })
    }
    return afterDefaults
  }

  for (const [serviceName, service] of Object.entries(newConfig.services ?? {})) {
    if (!service) continue

    // environment: map 形式（Record<string,string>）と list 形式（KEY=VALUE[]）の両対応
    const env = service.environment
    if (env && !Array.isArray(env) && typeof env === "object") {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== "string") continue
        ;(env as Record<string, string>)[key] = rewrite(value, `${serviceName}.environment.${key}`)
      }
    } else if (Array.isArray(env)) {
      service.environment = env.map((item, index) => {
        if (typeof item !== "string") return item
        // KEY=VALUE 形式なら VALUE 部分だけ伝播対象にする（KEY は維持）
        const eq = item.indexOf("=")
        if (eq === -1) {
          return rewrite(item, `${serviceName}.environment[${index}]`)
        }
        const key = item.slice(0, eq)
        const value = item.slice(eq + 1)
        const next = rewrite(value, `${serviceName}.environment.${key}`)
        return `${key}=${next}`
      })
    }

    // ports: `${VAR:-54321}:8000` のような変数入りエントリの **default 部分のみ** 伝播する。
    // - parseable な `host:container` リテラルは adjustPortsInCompose の管轄なので除外。
    // - propagatePortsInValue の `:port` 正規表現は使わない。ports 文字列に当てると
    //   コンテナ側ポート (例 "${VAR:-5432}:5432" の後半) まで書き換えてしまうため。
    //   propagateComposeDefaults だけを使い `${VAR:-default}` の default だけを直す。
    if (Array.isArray(service.ports)) {
      service.ports = service.ports.map((portMapping, index) => {
        if (typeof portMapping !== "string") return portMapping
        if (parsePortMapping(portMapping)) return portMapping
        const next = propagateComposeDefaults(portMapping, envChanges, map)
        if (next !== portMapping) {
          changes.push({ location: `${serviceName}.ports[${index}]`, from: portMapping, to: next })
        }
        return next
      })
    }
  }

  return { config: newConfig, changes }
}

/**
 * 使用可能なポート番号を検索
 *
 * @param basePort - 希望するベースポート番号
 * @param usedPorts - 使用中のポート番号配列
 * @returns 使用可能なポート番号
 *
 * @example
 * ```typescript
 * const usedPorts = [3000, 3001, 3002]
 * const availablePort = findAvailablePort(3000, usedPorts)
 * console.log(availablePort) // 3003
 * ```
 */
export function findAvailablePort(basePort: number, usedPorts: number[]): number {
  if (!isTcpPort(basePort)) {
    throw new Error(`Invalid TCP port: ${basePort}`)
  }
  const used = new Set(usedPorts.filter(isTcpPort))

  // README どおり「元の host port をまず試し、空いていればそのまま使う」。
  // 80 や 443、あるいは 9999 超の有効ポートを、空いているのに wtb のレンジ
  // [MIN, MAX] へ無理やり移動させてはいけない（旧実装はそうしていた）。
  if (basePort >= 1 && basePort <= MAX_TCP_PORT && !used.has(basePort)) {
    return basePort
  }

  // 使用中の場合のみ空きを探索する。特権ポートを避けるため、探索開始は
  // max(basePort + 1, PORT_RANGE.MIN) に寄せ、MAX_TCP_PORT まで上方向に探索し
  // その後 PORT_RANGE.MIN からの巻き戻しループを走る。
  // 旧実装は PORT_RANGE.MAX (9999) で打ち切っていたため、54321 のような高ポートでは
  // ループ本体が一切実行されず、使用中かもしれない basePort+1 を無検証で返していた。
  const start = Math.max(basePort + 1, PORT_RANGE.MIN)
  for (let p = start; p <= MAX_TCP_PORT; p++) {
    if (!used.has(p)) return p
  }
  for (let p = PORT_RANGE.MIN; p < Math.min(start, MAX_TCP_PORT + 1); p++) {
    if (!used.has(p)) return p
  }

  throw new Error(
    `No free TCP port available in range ${PORT_RANGE.MIN}-${MAX_TCP_PORT} for ${basePort}`
  )
}

function isTcpPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_TCP_PORT
}

function containsPortRange(value: string): boolean {
  return /\d+\s*-\s*\d+/.test(value)
}

function parseSinglePublishedPort(value: number | string): number | null {
  if (typeof value === "number") return isTcpPort(value) ? value : null
  if (!/^\d+$/.test(value)) return null
  const parsed = Number.parseInt(value, 10)
  return isTcpPort(parsed) ? parsed : null
}

/**
 * プロジェクトディレクトリからDocker Composeファイルを自動検出
 *
 * @param projectDir - プロジェクトディレクトリパス
 * @returns 見つかったComposeファイルのパス（見つからない場合はnull）
 *
 * @example
 * ```typescript
 * const composePath = findComposeFile('/path/to/project')
 * if (composePath) {
 *   console.log(`Found compose file: ${composePath}`)
 * } else {
 *   console.log('No compose file found')
 * }
 * ```
 */
export function findComposeFile(projectDir: string): string | null {
  for (const fileName of COMPOSE_FILE_NAMES) {
    const filePath = `${projectDir}/${fileName}`
    if (existsSync(filePath)) {
      return filePath
    }
  }
  return null
}

/**
 * Docker Compose v2 が実際に算出するプロジェクト名を解決する
 *
 * 優先順位 (Compose v2 の実挙動に整合 — `docker compose config --format json`
 * で実機確認済み。`COMPOSE_PROJECT_NAME` は `name:` より**強い**):
 * 1. `COMPOSE_PROJECT_NAME` 環境変数 (空でない場合) — `-p` フラグ相当の次に強い
 * 2. `composeConfig.name` (compose.yml の `name:`)
 * 3. workdir の basename を Compose 仕様で正規化:
 *    - lowercase 化
 *    - `[a-z0-9_-]` 以外の文字を **削除** (置換ではなく除去)
 *    - 先頭が letter/digit でなければ `wtb` を prepend
 *    - 結果が空なら "wtb-project" にフォールバック
 *
 * @param composeConfig - parse 済みの compose 設定
 * @param workdir - compose ファイルがあるディレクトリの絶対パス
 * @param env - 環境変数オブジェクト (テスト時に上書き可能、デフォルト `process.env`)
 * @returns Compose が `<project>_<volume>` の prefix として使う実プロジェクト名
 */
export function resolveComposeProjectName(
  composeConfig: ComposeConfig,
  workdir: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const fromEnv = env.COMPOSE_PROJECT_NAME
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return resolveProjectNameScalar(fromEnv, env, "COMPOSE_PROJECT_NAME")
  }
  const explicit = (composeConfig as { name?: unknown }).name
  if (typeof explicit === "string" && explicit.length > 0) {
    return resolveProjectNameScalar(explicit, env, "Compose name")
  }
  const baseName = path.basename(workdir)
  const stripped = baseName.toLowerCase().replace(/[^a-z0-9_-]/g, "")
  if (stripped.length === 0) {
    return "wtb-project"
  }
  if (!/^[a-z0-9]/.test(stripped)) {
    return `wtb${stripped}`
  }
  return stripped
}

/**
 * Resolve a project-name scalar using Compose interpolation rules. Returning a
 * literal `${VAR}` here would make every same-project safety guard reason about
 * a different name than Docker, so unresolved references fail closed.
 */
function resolveProjectNameScalar(
  raw: string,
  env: NodeJS.ProcessEnv,
  label: string
): string {
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") values[key] = value
  }
  const interpolated = interpolateComposeValue(raw, values)
  if (
    interpolated.unresolved.length > 0 ||
    containsVariableReference(interpolated.value) ||
    interpolated.value.length === 0
  ) {
    throw new Error(
      `${label} cannot be resolved safely${interpolated.unresolved.length > 0 ? ` (missing: ${interpolated.unresolved.join(", ")})` : ""}`
    )
  }
  return interpolated.value
}

/**
 * Resolve the environment Docker Compose loads for project identity.
 *
 * Compose reads `<workdir>/.env` for interpolation/project variables, while the
 * invoking process environment has higher precedence. Parsing errors are
 * intentionally propagated: destructive callers must not guess an identity.
 */
export function loadComposeInterpolationEnvironment(
  workdir: string,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const merged: Record<string, string> = {}
  const dotEnvPath = path.join(workdir, ".env")
  if (existsSync(dotEnvPath)) {
    const content = fs.readFileSync(dotEnvPath, { encoding: FILE_ENCODING })
    for (const line of content.split(/\r?\n/)) {
      // Compose accepts leading whitespace and an optional `export` prefix in
      // dotenv files. Normalize the assignment, then reuse the canonical value
      // parser for quotes and inline comments.
      const assignment = line.match(
        /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
      )
      if (!assignment) continue
      const parsed = parseEnvContent(`${assignment[1]}=${assignment[2]}`)
      const entry = parsed.entries[0]
      if (entry) merged[entry.key] = entry.value
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") merged[key] = value
  }
  return merged
}

const COMPOSE_SOURCE_OVERRIDE_KEYS = [
  "COMPOSE_FILE",
  "COMPOSE_ENV_FILES",
  "COMPOSE_PATH_SEPARATOR",
  "COMPOSE_DISABLE_ENV_FILE",
] as const

/**
 * Reject Compose pre-defined variables that change which files/environment a
 * later bare `docker compose` lifecycle command loads. They can come from the
 * target `.env` as well as the shell and would bypass wtb's rewritten file.
 */
export function assertNoComposeSourceOverrides(
  environment: Readonly<Record<string, string>>
): void {
  const active = COMPOSE_SOURCE_OVERRIDE_KEYS.filter(
    (key) => environment[key]?.trim().length > 0
  )
  if (active.length > 0) {
    throw new Error(
      `${active.join(", ")} must be unset; Compose source/env overrides can bypass wtb's isolated file`
    )
  }
}

/**
 * A shell-only project override is transient and can redirect lifecycle
 * commands to an unrelated existing project. Worktree `.env` remains
 * supported because it is inspected per worktree and checked for uniqueness.
 */
export function assertNoTransientComposeProjectOverride(
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env.COMPOSE_PROJECT_NAME?.trim()) {
    throw new Error(
      "Shell COMPOSE_PROJECT_NAME must be unset for wtb; define a stable per-worktree value in .env or Compose name instead"
    )
  }
}

/** Resolve a Compose project exactly enough for create/remove/prune safety guards. */
export function resolveComposeProjectNameForWorktree(
  composeConfig: ComposeConfig,
  workdir: string,
  env: NodeJS.ProcessEnv = process.env,
  projectDirectory: string = workdir
): string {
  const environment = loadComposeInterpolationEnvironment(workdir, env)
  assertNoComposeSourceOverrides(environment)
  return resolveComposeProjectName(composeConfig, projectDirectory, environment)
}

/**
 * branch 名を Compose v2 が許容するプロジェクト slug に正規化する。
 *
 * Compose v2 の project name は `[a-z0-9][a-z0-9_-]*` (lowercase 始まり) でなければ
 * ならない。規則:
 * - lowercase 化
 * - `[a-z0-9_-]` 以外を `-` に置換
 * - 連続する `-` を 1 つに畳む
 * - 先頭が `[a-z0-9]` でなければ先頭の不正文字を除去し、なお空/不正なら `wtb` を prepend
 * - 末尾の `-` は除去
 * - 結果が空なら "wtb" にフォールバック
 *
 * 例: `feature/Foo_Bar!` → `feature-foo_bar`
 */
export function sanitizeProjectSlug(branch: string): string {
  let s = branch.toLowerCase().replace(/[^a-z0-9_-]/g, "-")
  // 連続するダッシュを畳む
  s = s.replace(/-+/g, "-")
  // 先頭の非英数 (-, _) を除去
  s = s.replace(/^[^a-z0-9]+/, "")
  // 末尾のダッシュを除去
  s = s.replace(/-+$/, "")
  if (s.length === 0) {
    return "wtb"
  }
  if (!/^[a-z0-9]/.test(s)) {
    return `wtb${s}`
  }
  return s
}

/**
 * branch の slug が既存の他 worktree の slug と衝突する場合に、raw branch の短いハッシュを
 * 付けて一意化する。unicode/記号だけが違う別ブランチ (例 `機能-a` と `修正-a` は共に `a`、
 * 全 unicode のブランチは共に `wtb`) が同一 project slug に畳まれ、2 つ目の `docker compose
 * up` が 1 つ目のスタックを乗っ取る/衝突するのを防ぐ。衝突が無ければ素の slug をそのまま返す
 * ので、通常の ASCII ブランチの読みやすい名前は変わらない。
 *
 * @param branch - 対象ブランチ名
 * @param otherBranches - 既存の他 worktree のブランチ名 (自分自身を含んでいてもよい)
 */
export function uniqueProjectSlug(branch: string, otherBranches: string[]): string {
  const base = sanitizeProjectSlug(branch)
  const collides = otherBranches.some((b) => b !== branch && sanitizeProjectSlug(b) === base)
  if (!collides) return base
  const hash = createHash("sha1").update(branch).digest("hex").slice(0, 6)
  return sanitizeProjectSlug(`${base}-${hash}`)
}

/**
 * container_name の正規化。
 *
 * Docker container 名は `[a-zA-Z0-9][a-zA-Z0-9_.-]*` を許容する (project slug と違い
 * 大文字・ドットも可)。規則:
 * - `[a-zA-Z0-9_.-]` 以外を `-` に置換
 * - 先頭が許容文字でなければ除去し、なお空なら `wtb` を prepend
 * - 結果が空なら "wtb" にフォールバック
 *
 * project slug と分離しているのは、container 名はケースとドットを保持できるため。
 */
export function sanitizeContainerName(name: string): string {
  let s = name.replace(/[^a-zA-Z0-9_.-]/g, "-")
  s = s.replace(/^[^a-zA-Z0-9]+/, "")
  if (s.length === 0) {
    return "wtb"
  }
  if (!/^[a-zA-Z0-9]/.test(s)) {
    return `wtb${s}`
  }
  return s
}

/**
 * {@link rewriteComposeIdentity} が報告する identity 書き換えの内訳。
 */
export interface ComposeIdentityRewrite {
  /** top-level `name:` の書き換え (発生時のみ) */
  projectName?: { from: string; to: string }
  /** service ごとの container_name 書き換え。`to` が undefined なら strip (key 削除) */
  containerNames: Array<{ service: string; from: string; to?: string }>
}

/**
 * Compose 設定の per-worktree identity (project name / container_name) を書き換える純粋関数。
 *
 * structuredClone 上で動作し、元の config は変更しない。新しい config と、何を変えたかの
 * 内訳 ({@link ComposeIdentityRewrite}) を返す。
 *
 * 規則:
 * - isolateName=true → resolved/base project に slug を付けた top-level `name:` を設定。
 *   `name:` が無い場合も注入する。Compose file がネストされている場合や同じ basename の
 *   custom worktree path では directory fallback がsourceと衝突し得るため、省略できない。
 *   isolateName=false → `name:` 不変。
 * - service ごとの `container_name:`:
 *   - suffix (default): `sanitizeContainerName(`${original}-${slug}`)`
 *   - strip: `container_name` key を削除 (compose が `<project>-<service>-N` を自動生成)
 *   - keep: 不変
 */
export function rewriteComposeIdentity(
  config: ComposeConfig,
  opts: {
    slug: string
    isolateName: boolean
    containerNameMode: "suffix" | "strip" | "keep"
    /** Interpolation/.envを解決済みのsource project。name未指定時の注入にも使う。 */
    baseProjectName?: string
  }
): { config: ComposeConfig; rewrite: ComposeIdentityRewrite } {
  const newConfig = structuredClone(config) as ComposeConfig
  const rewrite: ComposeIdentityRewrite = { containerNames: [] }

  // top-level project name (`name:`)
  const originalName = (newConfig as { name?: unknown }).name
  const baseProjectName =
    opts.baseProjectName ??
    (typeof originalName === "string" && originalName.length > 0 ? originalName : undefined)
  if (opts.isolateName && baseProjectName) {
    const next = sanitizeProjectSlug(`${baseProjectName}-${opts.slug}`)
    if (next !== originalName) {
      ;(newConfig as { name?: string }).name = next
      rewrite.projectName = { from: baseProjectName, to: next }
    }
  }

  // per-service container_name
  if (opts.containerNameMode !== "keep" && newConfig.services) {
    for (const [serviceName, service] of Object.entries(newConfig.services)) {
      if (!service || typeof service !== "object") continue
      const current = (service as { container_name?: unknown }).container_name
      if (typeof current !== "string" || current.length === 0) continue

      if (opts.containerNameMode === "strip") {
        delete (service as { container_name?: unknown }).container_name
        rewrite.containerNames.push({ service: serviceName, from: current, to: undefined })
      } else {
        // suffix
        const next = sanitizeContainerName(`${current}-${opts.slug}`)
        if (next !== current) {
          ;(service as { container_name?: string }).container_name = next
          rewrite.containerNames.push({ service: serviceName, from: current, to: next })
        }
      }
    }
  }

  return { config: newConfig, rewrite }
}

/**
 * source の Docker Compose スタックを停止する (`docker compose stop`)。
 *
 * volume を安全にクローンするための一時停止に使う。`down` と違い、`stop` は
 * コンテナ・ネットワーク・volume を保持したままプロセスのみ止めるため、
 * 後で {@link composeStart} で素早く復帰できる。Postgres/MySQL/Redis などの
 * ライブ volume を破損なくコピーするために create フローから呼ばれる。
 *
 * @param composeFilePath - Compose ファイルの絶対パス
 * @param projectName - Compose プロジェクト名 (resolveComposeProjectName の結果)
 * @param cwd - 実行ディレクトリ (通常は source の gitRoot)
 * @throws {Error} docker 呼び出しが失敗した場合 (呼び出し側で握りつぶす想定)
 */
export function composeStop(composeFilePath: string, projectName: string, cwd: string): void {
  execDockerSafe(["compose", "-f", composeFilePath, "-p", projectName, "stop"], { cwd })
}

/**
 * {@link composeStop} で停止した source スタックを再開する (`docker compose start`)。
 *
 * @param composeFilePath - Compose ファイルの絶対パス
 * @param projectName - Compose プロジェクト名
 * @param cwd - 実行ディレクトリ (通常は source の gitRoot)
 * @throws {Error} docker 呼び出しが失敗した場合 (呼び出し側で握りつぶす想定)
 */
export function composeStart(composeFilePath: string, projectName: string, cwd: string): void {
  execDockerSafe(["compose", "-f", composeFilePath, "-p", projectName, "start"], { cwd })
}

/**
 * source スタックを `docker compose up -d` で復帰させる ({@link composeStart} のより堅牢な代替)。
 *
 * `start` は「停止済みコンテナの再開」しかできず、コンテナが削除/欠損していると失敗する。
 * `up -d` は依存解決しつつ欠損コンテナを再作成するため、`composeStart` が失敗した後の
 * フォールバックとして使う。
 *
 * @param composeFilePath - Compose ファイルの絶対パス
 * @param projectName - Compose プロジェクト名
 * @param cwd - 実行ディレクトリ (通常は source の gitRoot)
 * @throws {Error} docker 呼び出しが失敗した場合 (呼び出し側で握りつぶす想定)
 */
export function composeUp(composeFilePath: string, projectName: string, cwd: string): void {
  execDockerSafe(["compose", "-f", composeFilePath, "-p", projectName, "up", "-d"], { cwd })
}

/**
 * Compose スタックを破棄する (`docker compose down`)。
 *
 * `-f` / `-p` を明示して、env(COMPOSE_PROJECT_NAME) や固定 `name:` による
 * project 誤解決 (source スタックの巻き込み down) を防ぐ。呼び出し側は
 * {@link safeResolveComposeProjectName} で target project を解決し、source と
 * 一致しないことを確認してから渡すこと。
 *
 * @param composeFilePath - Compose ファイルの絶対パス
 * @param projectName - この worktree の Compose プロジェクト名
 * @param cwd - 実行ディレクトリ (通常は worktree のルート)
 * @param removeVolumes - true なら `down -v` で named volume も削除
 * @throws {Error} docker 呼び出しが失敗した場合 (呼び出し側でハンドリングする想定)
 */
export function composeDown(
  composeFilePath: string,
  projectName: string,
  cwd: string,
  removeVolumes = false
): void {
  const args = ["compose", "-f", composeFilePath, "-p", projectName, "down"]
  if (removeVolumes) {
    args.push("-v")
  }
  execDockerSafe(args, { cwd })
}

/**
 * compose ファイルを読んで Compose プロジェクト名を解決する。読めなければ null。
 *
 * remove / up / down の same-project ガード用: throw せず null を返すことで、
 * 「compose が読めない = project を特定できない」を安全側 (docker 呼び出し拒否)
 * に倒せる。
 */
export function safeResolveComposeProjectName(
  composePath: string,
  workdir: string
): string | null {
  try {
    assertNoTransientComposeProjectOverride(process.env)
    return resolveComposeProjectNameForWorktree(
      readComposeFile(composePath),
      workdir,
      process.env,
      path.dirname(composePath)
    )
  } catch {
    return null
  }
}
