/**
 * @fileoverview Docker クライアント操作
 * Dockerコンテナとボリュームの情報取得を担当
 */

import { execSync } from "node:child_process"
import { DOCKER_COMMANDS, FILE_ENCODING, WTB_PREFIX } from "../../constants/index.js"
import type { ContainerInfo, ExecOptions, VolumeInfo } from "../../types/index.js"

/**
 * Dockerコマンドを実行するための基本ヘルパー
 *
 * @param command - 実行するDockerコマンド
 * @param options - 実行オプション
 * @returns コマンドの出力結果
 * @throws {Error} コマンドの実行に失敗した場合
 */
function execDockerCommand(command: string, options?: ExecOptions): string {
  try {
    const execOptions = {
      encoding: FILE_ENCODING,
      stdio: "pipe" as const,
      ...(options?.cwd && { cwd: options.cwd }),
      ...(options?.env && { env: { ...process.env, ...options.env } }),
    }
    return execSync(command, execOptions).trim()
  } catch (error) {
    // execSync の error.message は "Command failed: <command>" を含むため、それを
    // そのまま前置するとコマンドが二重表示になる。実際の docker のエラー出力は
    // error.stderr にあるので、それを優先して原因が分かるメッセージにする。
    const e = error as { stderr?: Buffer | string; message?: string }
    const stderr = e.stderr ? e.stderr.toString().trim() : ""
    const detail = stderr || (error instanceof Error ? error.message : String(error))
    throw new Error(`Docker command failed: ${command}\n${detail}`)
  }
}

/**
 * 実行中のDockerコンテナ一覧を取得
 *
 * @param options - 実行オプション
 * @returns コンテナ情報の配列
 *
 * @example
 * ```typescript
 * const containers = getRunningContainers()
 * containers.forEach(container => {
 *   console.log(`${container.name}: ${container.status}`)
 * })
 * ```
 */
export function getRunningContainers(options?: ExecOptions): ContainerInfo[] {
  try {
    return getRunningContainersOrThrow(options)
  } catch (error) {
    console.warn(
      "Failed to get running containers:",
      error instanceof Error ? error.message : String(error)
    )
    return []
  }
}

/** Strict variant for allocation/destructive callers that must not treat daemon failure as empty. */
export function getRunningContainersOrThrow(options?: ExecOptions): ContainerInfo[] {
  return parseContainerList(execDockerCommand(DOCKER_COMMANDS.CONTAINERS, options))
}

/**
 * docker psの出力をパースしてコンテナ情報配列に変換
 *
 * @param output - docker psの出力
 * @returns パースされたコンテナ情報配列
 *
 * @example
 * ```typescript
 * const output = "abc123\tmy-app\tnginx:latest\tUp 5 minutes\t0.0.0.0:3000->80/tcp"
 * const containers = parseContainerList(output)
 * ```
 */
function parseContainerList(output: string): ContainerInfo[] {
  if (!output.trim()) {
    return []
  }

  const containers: ContainerInfo[] = []
  for (const line of output.split("\n")) {
    const parts = line.split("\t")
    if (parts.length < 4) {
      continue
    }

    const [id, name, image, status, ports = ""] = parts

    containers.push({
      id: id.trim(),
      name: name.trim(),
      image: image.trim(),
      status: status.trim(),
      ports: ports
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0),
    })
  }
  return containers
}

/**
 * Dockerボリューム一覧を取得
 *
 * @param options - 実行オプション
 * @returns ボリューム情報の配列
 *
 * @example
 * ```typescript
 * const volumes = getDockerVolumes()
 * volumes.forEach(volume => {
 *   console.log(`${volume.name}: ${volume.driver}`)
 * })
 * ```
 */
export function getDockerVolumes(options?: ExecOptions): VolumeInfo[] {
  try {
    const output = execDockerCommand(DOCKER_COMMANDS.VOLUMES, options)
    return parseVolumeList(output)
  } catch (error) {
    console.warn(
      "Failed to get Docker volumes:",
      error instanceof Error ? error.message : String(error)
    )
    return []
  }
}

/**
 * wtb が作成した（`wtb.managed=true` ラベル付き）volume 名の一覧を取得する。
 * 名前の命名規則に依存せず wtb 管理 volume を正確に特定できる。
 * Docker が使えない場合は空配列。
 *
 * @param options - 実行オプション
 * @returns wtb 管理 volume 名の配列
 */
export function getWtbManagedVolumeNames(repoLabel?: string, options?: ExecOptions): string[] {
  try {
    return getWtbManagedVolumeNamesOrThrow(repoLabel, options)
  } catch {
    return []
  }
}

/**
 * wtb 管理 volume を列挙し、Docker へ問い合わせできない場合は例外を伝播する。
 *
 * status のような表示系は上の best-effort API を使える一方、prune は問い合わせ失敗を
 * 「volume が 0 件」と誤認して成功扱いにしてはならないため、この strict API を使う。
 */
export function getWtbManagedVolumeNamesOrThrow(
  repoLabel?: string,
  options?: ExecOptions
): string[] {
  // repoLabel が渡されたら `wtb.repo=<hash>` でも絞る。値は repoVolumeLabel が返す
  // hex のみ許可し、shell 経由の既存 client 実装へ任意文字列を渡さない。
  const command =
    repoLabel && /^[a-f0-9]+$/.test(repoLabel)
      ? `docker volume ls --filter label=wtb.managed=true --filter label=wtb.repo=${repoLabel} --format "{{.Name}}"`
      : DOCKER_COMMANDS.MANAGED_VOLUMES
  const output = execDockerCommand(command, options)
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/**
 * docker volume lsの出力をパースしてボリューム情報配列に変換
 *
 * @param output - docker volume lsの出力
 * @returns パースされたボリューム情報配列
 */
function parseVolumeList(output: string): VolumeInfo[] {
  if (!output.trim()) {
    return []
  }

  return output
    .split("\n")
    .map((line) => {
      const parts = line.split("\t")
      if (parts.length < 2) {
        return null
      }

      const [name, driver, mountpoint = ""] = parts

      return {
        name: name.trim(),
        driver: driver.trim(),
        mountpoint: mountpoint.trim(),
      }
    })
    .filter((volume): volume is VolumeInfo => volume !== null)
}

/**
 * 実行中のコンテナから使用されているポート番号を抽出
 *
 * @param options - 実行オプション
 * @returns 使用中のポート番号配列
 *
 * @example
 * ```typescript
 * const usedPorts = getUsedPorts()
 * console.log(`Used ports: ${usedPorts.join(', ')}`)
 * ```
 */
export function getUsedPorts(options?: ExecOptions): number[] {
  return collectUsedPorts(getRunningContainers(options))
}

/** Strict published-port query used when assigning repository-wide ports. */
export function getUsedPortsOrThrow(options?: ExecOptions): number[] {
  return collectUsedPorts(getRunningContainersOrThrow(options))
}

function collectUsedPorts(containers: ContainerInfo[]): number[] {
  const ports = new Set<number>()

  containers.forEach((container) => {
    container.ports.forEach((portMapping) => {
      for (const port of publishedPortsFromDockerMapping(portMapping)) {
        ports.add(port)
      }
    })
  })

  return [...ports].sort((a, b) => a - b)
}

/** Parse Docker's IPv4/IPv6 published side and expand host port ranges. */
function publishedPortsFromDockerMapping(mapping: string): number[] {
  const withoutProtocol = mapping.trim().replace(/\/[A-Za-z][A-Za-z0-9]*$/, "")
  const arrow = withoutProtocol.indexOf("->")
  let publishedSide: string
  if (arrow >= 0) {
    const left = withoutProtocol.slice(0, arrow)
    if (left.startsWith("[")) {
      const bracketSeparator = left.lastIndexOf("]:")
      publishedSide = bracketSeparator >= 0 ? left.slice(bracketSeparator + 2) : left
    } else {
      const separator = left.lastIndexOf(":")
      publishedSide = separator >= 0 ? left.slice(separator + 1) : left
    }
  } else {
    // Preserve the historical conservative handling of unpublished ports and
    // tolerate the old short `HOST:CONTAINER` shape.
    const separator = withoutProtocol.lastIndexOf(":")
    publishedSide = separator >= 0 ? withoutProtocol.slice(0, separator) : withoutProtocol
  }

  const match = publishedSide.match(/^(\d+)(?:-(\d+))?$/)
  if (!match) return []
  const start = Number.parseInt(match[1], 10)
  const end = match[2] === undefined ? start : Number.parseInt(match[2], 10)
  if (start < 1 || end < start || end > 65535) return []
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}

/**
 * wtbプロジェクトのコンテナかどうかを判定
 *
 * @param container - 判定するコンテナ情報
 * @returns wtbプロジェクトのコンテナの場合true
 *
 * @example
 * ```typescript
 * const containers = getRunningContainers()
 * const wtbContainers = containers.filter(isWtbContainer)
 * console.log(`wtb containers: ${wtbContainers.length}`)
 * ```
 */
export function isWtbContainer(container: ContainerInfo): boolean {
  // コンテナ名にwtbが含まれている
  if (container.name.includes("wtb")) {
    return true
  }

  // 環境変数でwtbプロジェクトのコンテナか判定
  const wtbEnvVars = Object.keys(process.env).filter((key) => key.startsWith(WTB_PREFIX))

  return wtbEnvVars.some((envVar) => {
    const value = process.env[envVar]
    return value && container.name.includes(value)
  })
}

/**
 * Dockerの動作確認とバージョン情報を取得
 *
 * @param options - 実行オプション
 * @returns Docker情報オブジェクト
 *
 * @example
 * ```typescript
 * try {
 *   const info = getDockerInfo()
 *   console.log(`Docker: ${info.dockerVersion}`)
 *   console.log(`Compose: ${info.composeVersion}`)
 * } catch (error) {
 *   console.error('Docker is not available')
 * }
 * ```
 */
export function getDockerInfo(options?: ExecOptions) {
  try {
    const dockerVersion = execDockerCommand(DOCKER_COMMANDS.VERSION, options)

    let composeVersion = "unknown"
    try {
      const composeOutput = execDockerCommand(DOCKER_COMMANDS.COMPOSE_VERSION, options)
      const versionMatch = composeOutput.match(/version (\S+)/)
      if (versionMatch) {
        composeVersion = versionMatch[1]
      }
    } catch {
      // Docker Composeが利用できない場合は無視
    }

    return {
      dockerVersion,
      composeVersion,
      isAvailable: true,
    }
  } catch {
    throw new Error("Docker is not available or not running")
  }
}
