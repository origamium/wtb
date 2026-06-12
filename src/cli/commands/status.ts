/**
 * @fileoverview Status コマンド実装
 * Git worktreeとDockerの状態表示を担当
 */

// Utils
import { existsSync } from "node:fs"
import * as path from "node:path"
import { Command } from "commander"
import { ENV_FILE_NAMES } from "../../constants/index.js"
import { loadConfig } from "../../core/config/loader.js"
import {
  getDockerInfo,
  getDockerVolumes,
  getRunningContainers,
  getWtbManagedVolumeNames,
  isWtbContainer,
} from "../../core/docker/client.js"
import { findComposeFile, readComposeFile } from "../../core/docker/compose.js"
// Core modules
import { getCurrentBranch, getGitRoot, getGitRootOrThrow } from "../../core/git/repository.js"
import { listWorktrees } from "../../core/git/worktree.js"
import type { CommandOptions } from "../../types/index.js"
import { withErrorHandling } from "../utils/command-helpers.js"

/** `wtb status --json` の 1 worktree 分の形 */
interface WorktreeStatusJson {
  branch: string
  path: string
  isMain: boolean
  isCurrent: boolean
  compose: { file: string | null; services: number | null }
  envFiles: string[]
}

/** `wtb status --json` の全体の形 */
interface StatusJson {
  worktrees: WorktreeStatusJson[]
  docker: {
    /** docker_compose_file が設定されているか */
    configured: boolean
    /** Docker daemon に到達できたか */
    available: boolean
    version: string | null
    composeVersion: string | null
    containers: Array<{
      name: string
      image: string
      status: string
      ports: string[]
      isWtb: boolean
    }>
    volumes: {
      total: number
      wtb: Array<{ name: string; driver: string; labelled: boolean }>
    }
  }
}

/**
 * volume が wtb 管理かどうかを判定する。
 * `wtb.managed=true` ラベル (正確) を優先し、ラベル付与より前に作られた volume の
 * ため旧来の命名ヒューリスティック (wtb / worktree を含む) もフォールバックで併用する。
 */
function isWtbVolume(name: string, managedLabelSet: Set<string>): boolean {
  return managedLabelSet.has(name) || name.includes("wtb") || name.includes("worktree")
}

/**
 * statusコマンドを作成
 *
 * @returns Commander.js のCommandオブジェクト
 *
 * @example
 * ```typescript
 * const program = new Command()
 * program.addCommand(statusCommand())
 * ```
 */
export function statusCommand(): Command {
  return new Command("status")
    .description("Show status of worktrees and their Docker environments")
    .option("-a, --all", "Show all worktrees, not just current")
    .option("--docker-only", "Show only Docker-related information")
    .option("--json", "Output machine-readable JSON (worktrees + Docker state) on stdout")
    .action(withErrorHandling(executeStatusCommand))
}

/**
 * statusコマンドのメイン実行ロジック
 *
 * @param options - コマンドオプション
 * @throws {Error} 実行に失敗した場合
 *
 * @example
 * ```typescript
 * await executeStatusCommand({ all: true, dockerOnly: false })
 * ```
 */
async function executeStatusCommand(options: CommandOptions): Promise<void> {
  // Git リポジトリチェック + ルート取得
  const gitRoot = getGitRootOrThrow()

  // docker_compose_file 設定を取得（設定読み込みエラーは非致命的 → Docker スキップ）
  let dockerComposeFile = ""
  try {
    const config = loadConfig(gitRoot)
    dockerComposeFile = config.docker_compose_file
  } catch {
    // Config load error: treat Docker as unconfigured
  }

  // JSON モード: 人間向け出力の代わりに 1 つの機械可読オブジェクトを stdout へ。
  // ls --json / ports と揃え、coding agent が Docker 状態まで構造化して読めるようにする。
  if (options.json) {
    const payload = buildStatusJson(!!options.all, !!options.dockerOnly, dockerComposeFile)
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }

  // Worktree 状態表示（--docker-only でない場合）
  if (!options.dockerOnly) {
    await showWorktreeStatus(!!options.all)
  }

  // Docker 状態表示
  await showDockerStatus(dockerComposeFile)
}

/**
 * `--json` 用の状態オブジェクトを組み立てる。Docker が無い/止まっていても
 * 例外を投げず、`docker.available=false` で表現する (stdout は常に valid JSON)。
 */
function buildStatusJson(
  showAll: boolean,
  dockerOnly: boolean,
  dockerComposeFile: string
): StatusJson {
  const worktreesJson: WorktreeStatusJson[] = []

  if (!dockerOnly) {
    const worktrees = listWorktrees()
    const currentBranch = getCurrentBranch()
    const gitRoot = getGitRoot()
    const filtered = showAll ? worktrees : worktrees.filter((wt) => wt.branch === currentBranch)

    for (const wt of filtered) {
      const composeFilePath = findComposeFile(wt.path)
      let serviceCount: number | null = null
      if (composeFilePath) {
        try {
          serviceCount = Object.keys(readComposeFile(composeFilePath).services ?? {}).length
        } catch {
          serviceCount = null
        }
      }
      const envFiles = ENV_FILE_NAMES.filter((name) => existsSync(path.join(wt.path, name)))
      worktreesJson.push({
        branch: wt.branch,
        path: wt.path,
        isMain: wt.path === gitRoot,
        isCurrent: wt.branch === currentBranch,
        compose: {
          file: composeFilePath ? path.basename(composeFilePath) : null,
          services: serviceCount,
        },
        envFiles,
      })
    }
  }

  const docker: StatusJson["docker"] = {
    configured: !!dockerComposeFile,
    available: false,
    version: null,
    composeVersion: null,
    containers: [],
    volumes: { total: 0, wtb: [] },
  }

  if (dockerComposeFile) {
    try {
      const info = getDockerInfo()
      docker.available = info.isAvailable === true
      docker.version = info.dockerVersion ?? null
      docker.composeVersion = info.composeVersion ?? null
    } catch {
      docker.available = false
    }

    if (docker.available) {
      try {
        docker.containers = getRunningContainers().map((c) => ({
          name: c.name,
          image: c.image,
          status: c.status,
          ports: c.ports,
          isWtb: isWtbContainer(c),
        }))
      } catch {
        // leave containers empty on docker error
      }
      try {
        const volumes = getDockerVolumes()
        const managed = new Set(getWtbManagedVolumeNames())
        const wtbVolumes = volumes.filter((v) => isWtbVolume(v.name, managed))
        docker.volumes = {
          total: volumes.length,
          // labelled=false は命名ヒューリスティックのみで拾った legacy/疑似 volume。
          // wtb 管理の正確な判定にはこのフラグ (= wtb.managed=true ラベル) を使う。
          wtb: wtbVolumes.map((v) => ({
            name: v.name,
            driver: v.driver,
            labelled: managed.has(v.name),
          })),
        }
      } catch {
        // leave volumes at defaults on docker error
      }
    }
  }

  return { worktrees: worktreesJson, docker }
}

/**
 * Git worktree の状態を表示
 *
 * @param showAll - 全てのworktreeを表示するか（falseの場合は現在のブランチのみ）
 * @throws {Error} Git操作に失敗した場合
 *
 * @example
 * ```typescript
 * await showWorktreeStatus(true) // 全てのworktreeを表示
 * await showWorktreeStatus(false) // 現在のブランチのみ
 * ```
 */
async function showWorktreeStatus(showAll: boolean): Promise<void> {
  console.log("📁 Git Worktrees Status\n")

  const worktrees = listWorktrees()
  const currentBranch = getCurrentBranch()

  if (worktrees.length === 0) {
    console.log("No worktrees found")
    return
  }

  // フィルタリング: showAll が false の場合は現在のブランチのみ
  const filteredWorktrees = showAll
    ? worktrees
    : worktrees.filter((wt) => wt.branch === currentBranch)

  for (const worktree of filteredWorktrees) {
    const isMain = worktree.path === getGitRoot()
    const isCurrent = worktree.branch === currentBranch

    // ブランチ名表示（現在のブランチは → 付き）
    console.log(`${isCurrent ? "→" : " "} ${worktree.branch}${isMain ? " (main)" : ""}`)
    console.log(`   📂 ${worktree.path}`)

    // Docker Compose ファイルチェック
    await showWorktreeDockerInfo(worktree.path)

    // 環境ファイルチェック
    showWorktreeEnvFiles(worktree.path)

    console.log() // 空行
  }
}

/**
 * worktreeのDocker関連情報を表示
 *
 * @param worktreePath - worktreeのパス
 *
 * @example
 * ```typescript
 * await showWorktreeDockerInfo('/path/to/worktree')
 * ```
 */
async function showWorktreeDockerInfo(worktreePath: string): Promise<void> {
  const composeFilePath = findComposeFile(worktreePath)

  if (composeFilePath) {
    const composeFileName = path.basename(composeFilePath)
    console.log(`   🐳 Docker: ${composeFileName}`)

    try {
      const config = readComposeFile(composeFilePath)
      const serviceCount = Object.keys(config.services || {}).length
      console.log(`   📦 Services: ${serviceCount}`)
    } catch {
      console.log("   ⚠️  Error reading compose file")
    }
  } else {
    console.log("   🐳 Docker: No compose file")
  }
}

/**
 * worktreeの環境ファイル情報を表示
 *
 * @param worktreePath - worktreeのパス
 *
 * @example
 * ```typescript
 * showWorktreeEnvFiles('/path/to/worktree')
 * ```
 */
function showWorktreeEnvFiles(worktreePath: string): void {
  const existingEnvFiles = ENV_FILE_NAMES.filter((fileName) =>
    existsSync(path.join(worktreePath, fileName))
  )

  if (existingEnvFiles.length > 0) {
    console.log(`   🔧 Environment: ${existingEnvFiles.join(", ")}`)
  }
}

/**
 * Docker環境の状態を表示
 *
 * @throws {Error} Docker操作に失敗した場合
 *
 * @example
 * ```typescript
 * await showDockerStatus()
 * ```
 */
async function showDockerStatus(dockerComposeFile: string): Promise<void> {
  console.log("🐳 Docker Environment Status\n")

  if (!dockerComposeFile) {
    console.log("⚙️  Docker checks skipped (not configured)")
    return
  }

  try {
    // 実行中コンテナ表示
    await showRunningContainers()

    // ボリューム表示
    await showDockerVolumes()

    // Docker情報表示
    await showDockerInfo()
  } catch {
    console.log("⚠️  Docker is not available or not running")
  }
}

/**
 * 実行中のDockerコンテナを表示
 *
 * @example
 * ```typescript
 * await showRunningContainers()
 * ```
 */
async function showRunningContainers(): Promise<void> {
  const containers = getRunningContainers()
  console.log(`📦 Running Containers: ${containers.length}`)

  if (containers.length > 0) {
    console.log()
    containers.forEach((container) => {
      const isWtb = isWtbContainer(container)

      console.log(`${isWtb ? "🌿" : "📦"} ${container.name}`)
      console.log(`   🏷️  Image: ${container.image}`)
      console.log(`   🔗 Status: ${container.status}`)

      if (container.ports.length > 0) {
        console.log(`   🔌 Ports: ${container.ports.join(", ")}`)
      }

      console.log()
    })
  }
}

/**
 * Dockerボリューム情報を表示
 *
 * @example
 * ```typescript
 * await showDockerVolumes()
 * ```
 */
async function showDockerVolumes(): Promise<void> {
  const volumes = getDockerVolumes()
  const managed = new Set(getWtbManagedVolumeNames())
  const wtbVolumes = volumes.filter((v) => isWtbVolume(v.name, managed))

  console.log(`🗂️  Total Volumes: ${volumes.length}`)

  if (wtbVolumes.length > 0) {
    console.log(`🌿 wtb Volumes: ${wtbVolumes.length}`)
    console.log()

    wtbVolumes.forEach((volume) => {
      console.log(`   📁 ${volume.name}`)
      console.log(`      Driver: ${volume.driver}`)
    })
    console.log()
  }
}

/**
 * Docker システム情報を表示
 *
 * @example
 * ```typescript
 * await showDockerInfo()
 * ```
 */
async function showDockerInfo(): Promise<void> {
  try {
    const info = getDockerInfo()

    console.log("🔧 Docker Information")
    console.log(`   ${info.dockerVersion}`)
    console.log(`   Docker Compose: ${info.composeVersion}`)
  } catch {
    console.log("⚠️  Could not retrieve Docker version information")
  }
}
