/**
 * @fileoverview Docker Compose ファイル操作
 * Docker Composeファイルの読み込み、書き込み、ポート調整を担当
 */

import { existsSync } from "node:fs"
import fs from "fs-extra"
import { parse, parseDocument, stringify, visit } from "yaml"
import {
  COMPOSE_FILE_NAMES,
  FILE_ENCODING,
  MAX_TCP_PORT,
  PORT_RANGE,
} from "../../constants/index.js"
import type { ComposeConfig, FileOperationOptions } from "../../types/index.js"
import { execDockerSafe } from "../../utils/exec.js"
import { out } from "../../utils/output.js"
import {
  type PortMap,
  propagateComposeDefaults,
  propagatePortsInValue,
} from "../environment/propagate.js"

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

    const parsed = parse(content) as ComposeConfig

    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid Docker Compose file format")
    }

    if (!parsed.services || typeof parsed.services !== "object") {
      throw new Error("Docker Compose file must contain a services section")
    }

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
    // We parse into a Document, visit all scalar string VALUES (not keys) in
    // mapping nodes, and force double-quote on any that are in the danger set.
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
      Pair(_, pair) {
        // Only force-quote the VALUE side of mapping pairs, not keys
        const val = pair.value
        if (
          val !== null &&
          typeof val === "object" &&
          "type" in val &&
          (val as { type: unknown }).type === "PLAIN" &&
          "value" in val &&
          typeof (val as { value: unknown }).value === "string" &&
          isDangerous((val as { value: string }).value)
        ) {
          ;(val as { type: string }).type = "QUOTE_DOUBLE"
        }
      },
    })

    const yamlContent = String(doc)

    fs.writeFileSync(filePath, yamlContent, {
      encoding: options?.encoding || FILE_ENCODING,
    })

    out(`📄 Wrote Docker Compose file: ${filePath}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to write Docker Compose file: ${message}`)
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
 * Docker Compose のポートマッピング文字列を解析
 * 対応形式: "3000:80", "0.0.0.0:3000:80", "3000:80/tcp"
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
  // Capture: optional IP prefix, host port, container port, optional /proto suffix
  const match = portMapping.match(/^([\d.]+:)?(\d+):(\d+)(\/\w+)?$/)
  if (!match) return null
  const hostPort = parseInt(match[2], 10)
  const containerPort = parseInt(match[3], 10)
  if (Number.isNaN(hostPort) || Number.isNaN(containerPort)) return null
  return {
    hostPort,
    containerPort,
    ip: match[1],      // e.g. "0.0.0.0:" or undefined
    proto: match[4],   // e.g. "/tcp" or undefined
  }
}

export function adjustPortsInCompose(config: ComposeConfig, usedPorts: number[]): ComposeConfig {
  // 深いコピーを作成して元のオブジェクトを変更しない
  const newConfig = structuredClone(config) as ComposeConfig
  const currentlyUsed = [...usedPorts]

  Object.entries(newConfig.services).forEach(([, service]) => {
    if (service.ports && Array.isArray(service.ports)) {
      service.ports = service.ports.map((portMapping) => {
        if (typeof portMapping !== "string") {
          return portMapping
        }

        const parsed = parsePortMapping(portMapping)
        if (!parsed) {
          return portMapping // 解析できない形式はそのまま
        }

        const newHostPort = findAvailablePort(parsed.hostPort, currentlyUsed)

        // 新しいポートを使用中リストに追加
        currentlyUsed.push(newHostPort)

        // Reconstruct from parsed components to avoid corrupting IP octets
        // that share digits with the host port (H3 fix).
        // e.g. "192.168.100.100:100:80/tcp" → "192.168.100.100:999:80/tcp"
        return `${parsed.ip ?? ""}${newHostPort}:${parsed.containerPort}${parsed.proto ?? ""}`
      })
    }
  })

  return newConfig
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
  const rewrite = (raw: string, location: string): string => {
    const afterDefaults = propagateComposeDefaults(raw, envChanges, map)
    const afterPorts = propagatePortsInValue(afterDefaults, map).value
    if (afterPorts !== raw) {
      changes.push({ location, from: raw, to: afterPorts })
    }
    return afterPorts
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

    // ports: 文字列エントリのみ対象（`${VAR:-54321}:8000` 形式を修正）
    if (Array.isArray(service.ports)) {
      service.ports = service.ports.map((portMapping, index) => {
        if (typeof portMapping !== "string") return portMapping
        return rewrite(portMapping, `${serviceName}.ports[${index}]`)
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
  const used = new Set(usedPorts)

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
  for (let p = PORT_RANGE.MIN; p < start; p++) {
    if (!used.has(p)) return p
  }

  // 全ポートが埋まっている場合のみ警告して basePort を返す（事実上到達しない）。
  console.warn(
    `⚠️  No free port available in range ${PORT_RANGE.MIN}-${MAX_TCP_PORT}; keeping original port ${basePort}`
  )
  return basePort
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
 * Docker Composeプロジェクト名を生成
 * 通常はディレクトリ名にworktreeの識別子を追加
 *
 * @param projectDir - プロジェクトディレクトリパス
 * @param branchName - ブランチ名（オプション）
 * @returns プロジェクト名
 *
 * @example
 * ```typescript
 * const projectName = generateProjectName('/path/to/my-app', 'feature-branch')
 * console.log(projectName) // "my-app-feature-branch"
 * ```
 */
export function generateProjectName(projectDir: string, branchName?: string): string {
  const baseName = projectDir.split("/").pop() || "wtb-project"
  const cleanBaseName = baseName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()

  if (branchName) {
    const cleanBranchName = branchName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()
    return `${cleanBaseName}-${cleanBranchName}`
  }

  return cleanBaseName
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
 * `generateProjectName` は非英数を `-` に置換するため、underscore や dot を含む
 * ディレクトリ名で Compose の実挙動と乖離する。Volume 名解決には必ずこちらを使うこと。
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
    return fromEnv
  }
  const explicit = (composeConfig as { name?: unknown }).name
  if (typeof explicit === "string" && explicit.length > 0) {
    return explicit
  }
  const baseName = workdir.split("/").pop() || ""
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
 * Docker Compose設定の妥当性をチェック
 *
 * @param config - チェックする設定オブジェクト
 * @returns 妥当性チェック結果
 *
 * @example
 * ```typescript
 * const result = validateComposeConfig(config)
 * if (result.isValid) {
 *   console.log('Configuration is valid')
 * } else {
 *   console.error('Validation errors:', result.errors)
 * }
 * ```
 */
export function validateComposeConfig(config: ComposeConfig): {
  isValid: boolean
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []

  // バージョンチェック（Docker Compose v2 では version フィールドは任意）
  if (!config.version) {
    warnings.push("Missing version field (optional in Docker Compose v2)")
  }

  // サービスチェック
  if (!config.services || Object.keys(config.services).length === 0) {
    errors.push("No services defined")
  } else {
    Object.entries(config.services).forEach(([serviceName, service]) => {
      if (!service.image && !service.build) {
        errors.push(`Service '${serviceName}' must have either 'image' or 'build' specified`)
      }

      if (service.ports && Array.isArray(service.ports)) {
        service.ports.forEach((port, index: number) => {
          if (typeof port !== "string" && typeof port !== "number") {
            warnings.push(`Service '${serviceName}' port[${index}] should be a string or number`)
          }
        })
      }
    })
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  }
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
 * - top-level `name:` あり AND isolateName=true → `sanitizeProjectSlug(`${name}-${slug}`)`
 *   (結合後を再 sanitize して常に valid にする)。`name:` 無し → そのまま (worktree dir
 *   basename が既に一意な project を生むので、注入は port/down 挙動を無駄に変える)。
 *   isolateName=false → `name:` 不変。
 * - service ごとの `container_name:`:
 *   - suffix (default): `sanitizeContainerName(`${original}-${slug}`)`
 *   - strip: `container_name` key を削除 (compose が `<project>-<service>-N` を自動生成)
 *   - keep: 不変
 */
export function rewriteComposeIdentity(
  config: ComposeConfig,
  opts: { slug: string; isolateName: boolean; containerNameMode: "suffix" | "strip" | "keep" }
): { config: ComposeConfig; rewrite: ComposeIdentityRewrite } {
  const newConfig = structuredClone(config) as ComposeConfig
  const rewrite: ComposeIdentityRewrite = { containerNames: [] }

  // top-level project name (`name:`)
  const originalName = (newConfig as { name?: unknown }).name
  if (opts.isolateName && typeof originalName === "string" && originalName.length > 0) {
    const next = sanitizeProjectSlug(`${originalName}-${opts.slug}`)
    if (next !== originalName) {
      ;(newConfig as { name?: string }).name = next
      rewrite.projectName = { from: originalName, to: next }
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
