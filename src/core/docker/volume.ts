/**
 * @fileoverview Docker Volume 操作
 * Dockerボリュームのコピー、作成、削除を担当
 * パフォーマンスを考慮したrsyncベースの実装
 */

import { spawn } from "node:child_process"
import { FILE_ENCODING } from "../../constants/index.js"
import type { ComposeConfig } from "../../types/index.js"
import { execDockerSafe } from "../../utils/exec.js"

/**
 * ボリュームコピーの進捗情報
 */
export interface VolumeCopyProgress {
  sourceVolume: string
  targetVolume: string
  percentage: number
  bytesTransferred: number
  totalBytes: number
  speed: number
  eta: number
}

/**
 * ボリュームコピーのオプション
 */
export interface VolumeCopyOptions {
  onProgress?: (progress: VolumeCopyProgress) => void
  /** rsync `--delete` 相当を有効化(target の余剰ファイルを消す) */
  incremental?: boolean
  /** rsync `-z` 相当(cp フォールバックでは無視) */
  compress?: boolean
}

/**
 * ボリュームのサイズを取得する。
 *
 * @param volumeName - ボリューム名
 * @returns サイズ(バイト)。空の volume は `0`。**サイズを確定できなかった場合
 *   (docker エラー / 出力が数値でない) は `null`** を返す。`null` と `0` を区別
 *   することが重要: コピーの skip / 破壊的な上書き判定はこの値に依存するため、
 *   「プローブ失敗」を「空」と取り違えると既存データを誤って消しかねない。
 */
export function getVolumeSize(volumeName: string): number | null {
  try {
    const output = execDockerSafe(
      [
        "run",
        "--rm",
        "-v",
        `${volumeName}:/data`,
        "alpine",
        "sh",
        "-c",
        "du -sb /data 2>/dev/null | cut -f1",
      ],
      {}
    )
    const size = parseInt(output, 10)
    return Number.isNaN(size) ? null : size
  } catch {
    return null
  }
}

/**
 * ボリュームを作成
 *
 * @param volumeName - 作成するボリューム名
 * @param driver - ドライバー（デフォルト: local）
 */
export function createVolume(volumeName: string, driver: string = "local"): void {
  execDockerSafe(["volume", "create", "--driver", driver, volumeName], {})
}

/**
 * volume を削除する (best-effort)。
 *
 * atomic overwrite の一時 volume の後始末に使う。存在しない / 使用中などで失敗
 * しても例外は投げない (元のエラーを隠さないため)。
 */
export function removeVolume(volumeName: string): void {
  try {
    execDockerSafe(["volume", "rm", "-f", volumeName], {})
  } catch {
    // best-effort cleanup; 失敗しても呼び出し側の処理は続行する
  }
}

/**
 * volume の中身を全削除する (`find /target -mindepth 1 -delete` 相当)。
 *
 * `cp -a /source/. /target/` 単体では target の余剰ファイルが残るため、上書き
 * セマンティクスを保つコピー前のクリアに使う。copyVolumeWithCp と atomic
 * overwrite の commit 段階で共有する。
 */
function clearVolume(volumeName: string): void {
  execDockerSafe(
    [
      "run",
      "--rm",
      "-v",
      `${volumeName}:/target`,
      "alpine",
      "sh",
      "-c",
      "find /target -mindepth 1 -delete",
    ],
    {}
  )
}

/**
 * atomic overwrite 用の一時 volume 名を生成する。
 * pid + 時刻 + 乱数で衝突を実質回避する (並行 create / リトライ対策)。
 * Docker volume 名の許容文字 [a-zA-Z0-9_.-] のみを使う。
 */
function makeTempVolumeName(targetVolume: string): string {
  const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  return `${targetVolume}__wtbtmp_${suffix}`
}

/**
 * rsyncを使用した高速ボリュームコピー
 *
 * @param sourceVolume - コピー元ボリューム名
 * @param targetVolume - コピー先ボリューム名
 * @param options - コピーオプション
 * @returns コピー結果のPromise
 */
export async function copyVolumeWithRsync(
  sourceVolume: string,
  targetVolume: string,
  options: VolumeCopyOptions = {}
): Promise<void> {
  const { onProgress, incremental = true, compress = false } = options

  try {
    createVolume(targetVolume)
  } catch {
    // 既に存在する場合は無視
  }

  const totalBytes = getVolumeSize(sourceVolume) ?? 0

  const rsyncFlags = ["-a", "--info=progress2", "--no-inc-recursive"]

  if (incremental) {
    rsyncFlags.push("--delete")
  }

  if (compress) {
    rsyncFlags.push("-z")
  }

  const rsyncCommand = `rsync ${rsyncFlags.join(" ")} /source/ /target/`

  return new Promise((resolve, reject) => {
    const dockerProcess = spawn("docker", [
      "run",
      "--rm",
      "-v",
      `${sourceVolume}:/source:ro`,
      "-v",
      `${targetVolume}:/target`,
      "instrumentisto/rsync-ssh",
      "sh",
      "-c",
      rsyncCommand,
    ])

    let lastProgress: VolumeCopyProgress = {
      sourceVolume,
      targetVolume,
      percentage: 0,
      bytesTransferred: 0,
      totalBytes,
      speed: 0,
      eta: 0,
    }

    dockerProcess.stdout.on("data", (data: Buffer) => {
      const output = data.toString()

      const progressMatch = output.match(/(\d[\d,]*)\s+(\d+)%\s+([\d.]+\w+\/s)\s+(\d+:\d+:\d+)/)

      if (progressMatch && onProgress) {
        const bytesTransferred = parseInt(progressMatch[1].replace(/,/g, ""), 10)
        const percentage = parseInt(progressMatch[2], 10)
        const speedStr = progressMatch[3]
        const etaStr = progressMatch[4]

        const speedMatch = speedStr.match(/([\d.]+)(\w+)/)
        let speed = 0
        if (speedMatch) {
          const value = parseFloat(speedMatch[1])
          const unit = speedMatch[2].toLowerCase()
          const multipliers: Record<string, number> = {
            "b/s": 1,
            "kb/s": 1024,
            "mb/s": 1024 * 1024,
            "gb/s": 1024 * 1024 * 1024,
          }
          speed = value * (multipliers[unit] || 1)
        }

        const etaParts = etaStr.split(":").map(Number)
        const eta = etaParts[0] * 3600 + etaParts[1] * 60 + etaParts[2]

        lastProgress = {
          sourceVolume,
          targetVolume,
          percentage,
          bytesTransferred,
          totalBytes,
          speed,
          eta,
        }

        onProgress(lastProgress)
      }
    })

    dockerProcess.stderr.on("data", (data: Buffer) => {
      const error = data.toString()
      if (error.includes("error") || error.includes("failed")) {
        console.error("rsync error:", error)
      }
    })

    dockerProcess.on("close", (code) => {
      if (code === 0) {
        if (onProgress) {
          onProgress({
            ...lastProgress,
            percentage: 100,
            bytesTransferred: totalBytes,
          })
        }
        resolve()
      } else {
        reject(new Error(`Volume copy failed with exit code ${code}`))
      }
    })

    dockerProcess.on("error", (error) => {
      reject(error)
    })
  })
}

/**
 * cpコマンドを使用したボリュームコピー（フォールバック用）
 *
 * @param sourceVolume - コピー元ボリューム名
 * @param targetVolume - コピー先ボリューム名
 * @param options - コピー設定 (onProgress, clearTarget)
 *
 * `clearTarget: true` を指定すると、コピー前に target volume の中身を全削除する
 * (rsync の `--delete` 相当)。`--force-volume-copy` 経由で呼ばれた際の上書き
 * セマンティクスを保つために必要。デフォルトは false (既存ファイル保持) で、
 * これは rsync の非 incremental 動作と等価。
 */
export async function copyVolumeWithCp(
  sourceVolume: string,
  targetVolume: string,
  options: {
    onProgress?: (progress: VolumeCopyProgress) => void
    clearTarget?: boolean
  } = {}
): Promise<void> {
  const { onProgress, clearTarget = false } = options
  try {
    createVolume(targetVolume)
  } catch {
    // 既に存在する場合は無視
  }

  const totalBytes = getVolumeSize(sourceVolume) ?? 0

  if (onProgress) {
    onProgress({
      sourceVolume,
      targetVolume,
      percentage: 0,
      bytesTransferred: 0,
      totalBytes,
      speed: 0,
      eta: 0,
    })
  }

  // force 時は target の既存ファイルを先に消す。
  // `cp -a /source/. /target/` 単体では target の余分なファイルが残るため。
  if (clearTarget) {
    clearVolume(targetVolume)
  }

  execDockerSafe(
    [
      "run",
      "--rm",
      "-v",
      `${sourceVolume}:/source:ro`,
      "-v",
      `${targetVolume}:/target`,
      "alpine",
      "sh",
      "-c",
      "cp -a /source/. /target/",
    ],
    {}
  )

  if (onProgress) {
    onProgress({
      sourceVolume,
      targetVolume,
      percentage: 100,
      bytesTransferred: totalBytes,
      totalBytes,
      speed: 0,
      eta: 0,
    })
  }
}

/**
 * 最適な方法でボリュームをコピー
 * rsyncが利用可能な場合はrsyncを使用、そうでなければcpを使用
 *
 * @param sourceVolume - コピー元ボリューム名
 * @param targetVolume - コピー先ボリューム名
 * @param options - コピーオプション。`clearTarget: true` で rsync 失敗時の cp
 *   フォールバックでも target 上書き保証 (rsync は incremental: true で `--delete`、
 *   cp 側はこのオプションを `find ... -delete` に翻訳して再現する)
 * @returns コピー結果のPromise
 */
export async function copyVolume(
  sourceVolume: string,
  targetVolume: string,
  options: VolumeCopyOptions & { clearTarget?: boolean } = {}
): Promise<void> {
  // 既存データの上書き (clearTarget=true) は破壊的なので atomic 経路を使う。
  // 「先に target を消してからコピー」だとコピー途中で失敗したとき target が空に
  // なって復旧不能になるため、完全な staged コピーが出来てから初めて target を
  // 置換する。
  if (options.clearTarget === true) {
    return copyVolumeAtomicOverwrite(sourceVolume, targetVolume, options)
  }

  try {
    await copyVolumeWithRsync(sourceVolume, targetVolume, {
      ...options,
      incremental: options.incremental,
    })
  } catch (error) {
    console.warn("rsync copy failed, falling back to cp:", error)
    await copyVolumeWithCp(sourceVolume, targetVolume, {
      onProgress: options.onProgress,
    })
  }
}

/**
 * 既存データを持つ target を atomic に上書きする。
 *
 * 1. stage  : source を新しい空の一時 volume へ完全コピー (本番の転送)。target には
 *             一切触れないので、ここで失敗しても target の既存データは無傷。
 * 2. verify : source に中身があるのに staged コピーが空なら中断 (中途半端な上書き防止)。
 * 3. commit : ここで初めて target を消し、検証済みの一時 volume から埋め直す
 *             (ローカル間コピーなので高速で、source 側の事情では失敗しない)。
 * 4. cleanup: 一時 volume は finally で必ず削除する (best-effort)。
 *
 * Docker には volume rename が無いため真の O(1) swap は不可能。この設計は target が
 * 空になる窓を「検証済みデータからのローカルコピー」だけに最小化し、ネットワーク /
 * source 読み取りの失敗で target を空にすることは決してない。
 */
async function copyVolumeAtomicOverwrite(
  sourceVolume: string,
  targetVolume: string,
  options: VolumeCopyOptions
): Promise<void> {
  const tmp = makeTempVolumeName(targetVolume)
  try {
    createVolume(tmp)
    // 1. stage
    await copyVolume(sourceVolume, tmp, { onProgress: options.onProgress })
    // 2. verify — この gate だけが破壊的な commit を守る。サイズを確定できない
    //    (getVolumeSize が null) 場合は「空かもしれない」を「空でない」と誤認して
    //    target を消すことがないよう、確認できないなら必ず abort する。
    const sourceSize = getVolumeSize(sourceVolume)
    const stagedSize = getVolumeSize(tmp)
    if (sourceSize === null || stagedSize === null) {
      throw new Error(
        `Cannot verify staged copy of '${sourceVolume}' (volume size probe failed) — aborting overwrite to protect '${targetVolume}'`
      )
    }
    if (sourceSize > 0 && stagedSize === 0) {
      throw new Error(
        `Staged copy of '${sourceVolume}' is empty — aborting overwrite to protect '${targetVolume}'`
      )
    }
    // 3. commit (target を消すのはここが初めて)
    await copyVolumeWithCp(tmp, targetVolume, { clearTarget: true })
  } finally {
    // 4. cleanup (createVolume も try 内に入れたので、途中失敗でも temp を掃除する)
    removeVolume(tmp)
  }
}

/**
 * バイト数を人間が読みやすい形式にフォーマット
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"

  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / 1024 ** i

  return `${value.toFixed(2)} ${units[i]}`
}

/**
 * 秒数を人間が読みやすい形式にフォーマット
 */
export function formatEta(seconds: number): string {
  if (seconds <= 0) return "--:--"

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`
}

// Re-export FILE_ENCODING for backward compat
export { FILE_ENCODING }

/**
 * 解決された volume の情報
 */
export interface ResolvedVolume {
  /** 実 Docker volume 名 */
  name: string
  /** external (共有意図) かどうか */
  external: boolean
}

/**
 * Compose ファイル内の volume key から、実 Docker volume 名を解決する
 *
 * 規則 (compose-spec v2 準拠):
 * - `volumes.<key>.external: true` で `name` 未指定 → `{ name: <key>, external: true }`
 *   (compose-spec: external で名前未指定なら key 自体が外部 volume 名)
 * - `volumes.<key>.external: { name: "foo" }` → `{ name: "foo", external: true }`
 * - `volumes.<key>.external: true` + `volumes.<key>.name: "foo"` → `{ name: "foo", external: true }`
 * - `volumes.<key>.name: "foo"` (external なし) → `{ name: "foo", external: false }`
 * - 上記なし (空オブジェクト or null) → `{ name: "<projectName>_<key>", external: false }`
 *
 * @param composeConfig - パース済 compose 設定
 * @param volumeKey - compose の volumes セクションの key
 * @param projectName - Docker Compose project name (ディレクトリ名から導出)
 * @returns 解決結果。共有意図で名前不定なら null
 */
export function resolveVolumeName(
  composeConfig: ComposeConfig,
  volumeKey: string,
  projectName: string,
): ResolvedVolume | null {
  const volumes = composeConfig.volumes
  if (!volumes || !(volumeKey in volumes)) {
    return null
  }

  const entry = volumes[volumeKey]

  // 空のエントリ (volume_name: のみ) は { name: <project>_<key> }
  if (entry === null || entry === undefined) {
    return { name: `${projectName}_${volumeKey}`, external: false }
  }

  if (typeof entry !== "object") {
    return { name: `${projectName}_${volumeKey}`, external: false }
  }

  // external フィールドの解釈
  let isExternal = false
  let externalName: string | undefined

  if (entry.external === true) {
    isExternal = true
  } else if (entry.external && typeof entry.external === "object") {
    isExternal = true
    if (typeof entry.external.name === "string") {
      externalName = entry.external.name
    }
  }

  // name フィールドの優先順位
  const explicitName: string | undefined =
    typeof entry.name === "string" ? entry.name : externalName

  if (isExternal) {
    if (!explicitName) {
      // external で名前不定 → key 自体が外部 volume 名
      // (compose-spec: external: true で名前未指定なら key がそのまま使われる)
      return { name: volumeKey, external: true }
    }
    return { name: explicitName, external: true }
  }

  if (explicitName) {
    return { name: explicitName, external: false }
  }

  return { name: `${projectName}_${volumeKey}`, external: false }
}

/**
 * Docker Compose の `volumes:` セクションから、クローン対象の named volume key 一覧を抽出
 *
 * - external な volume は除外 (共有意図)
 * - exclude に含まれる key は除外
 *
 * @param composeConfig - パース済 compose 設定
 * @param exclude - 除外する key 一覧
 * @returns クローン対象の volume key 配列
 */
export function discoverCloneableVolumes(
  composeConfig: ComposeConfig,
  exclude: string[] = [],
): string[] {
  if (!composeConfig.volumes) return []
  const excludeSet = new Set(exclude)
  const result: string[] = []
  for (const key of Object.keys(composeConfig.volumes)) {
    if (excludeSet.has(key)) continue
    const entry = composeConfig.volumes[key]
    if (entry && typeof entry === "object") {
      if (entry.external === true || (entry.external && typeof entry.external === "object")) {
        continue // external は対象外
      }
    }
    result.push(key)
  }
  return result
}

/**
 * 指定 volume を使用している稼働中コンテナの一覧を取得
 *
 * @param volumeName - 検査対象の Docker volume 名
 * @returns 該当する running container 名一覧
 */
export function getContainersUsingVolume(volumeName: string): string[] {
  try {
    const output = execDockerSafe(
      ["ps", "--filter", `volume=${volumeName}`, "--format", "{{.Names}}"],
      {},
    )
    if (!output) return []
    return output
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  } catch {
    return []
  }
}

/**
 * Docker volume が存在するかをチェック
 */
export function volumeExists(volumeName: string): boolean {
  try {
    execDockerSafe(["volume", "inspect", volumeName], {})
    return true
  } catch {
    return false
  }
}
