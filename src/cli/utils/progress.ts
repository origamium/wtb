/**
 * @fileoverview CLI プログレス表示ユーティリティ
 * ターミナルでのプログレスバー表示を担当
 */

import type { VolumeCopyProgress } from "../../core/docker/volume.js"
import { formatBytes, formatEta } from "../../core/docker/volume.js"
import { outStream } from "../../utils/output.js"

/**
 * プログレスバーのオプション
 */
export interface ProgressBarOptions {
  /** バーの幅（文字数） */
  width?: number
  /** 完了文字 */
  completeChar?: string
  /** 未完了文字 */
  incompleteChar?: string
  /** 色を使用するか */
  useColors?: boolean
}

/**
 * シンプルなプログレスバーを生成
 *
 * @param percentage - 進捗率 (0-100)
 * @param options - オプション
 * @returns プログレスバー文字列
 */
export function createProgressBar(percentage: number, options: ProgressBarOptions = {}): string {
  const { width = 30, completeChar = "█", incompleteChar = "░", useColors = true } = options

  const completed = Math.floor((percentage / 100) * width)
  const remaining = width - completed

  const bar = completeChar.repeat(completed) + incompleteChar.repeat(remaining)
  const percentStr = `${percentage.toFixed(0).padStart(3)}%`

  if (useColors) {
    // 緑色でプログレスバーを表示
    return `\x1b[32m${bar}\x1b[0m ${percentStr}`
  }

  return `${bar} ${percentStr}`
}

/**
 * ボリュームコピーの進捗表示を生成
 *
 * @param progress - 進捗情報
 * @param options - オプション
 * @returns 表示用文字列
 */
export function formatVolumeCopyProgress(
  progress: VolumeCopyProgress,
  options: ProgressBarOptions = {}
): string {
  const bar = createProgressBar(progress.percentage, options)
  const transferred = formatBytes(progress.bytesTransferred)
  const total = formatBytes(progress.totalBytes)
  const speed = `${formatBytes(progress.speed)}/s`
  const eta = formatEta(progress.eta)

  return `${bar} | ${transferred}/${total} | ${speed} | ETA: ${eta}`
}

/**
 * ターミナルの同じ行を更新して進捗表示
 *
 * @param message - 表示するメッセージ
 */
export function updateProgressLine(message: string): void {
  outStream().write(`\r\x1b[K${message}`)
}

/**
 * 進捗表示を完了（改行を追加）
 */
export function finishProgressLine(): void {
  outStream().write("\n")
}

/**
 * ボリュームコピー用のプログレスハンドラーを作成
 *
 * @param label - 表示ラベル
 * @returns 進捗コールバック関数
 *
 * @example
 * ```typescript
 * await copyVolume('source', 'target', {
 *   onProgress: createVolumeCopyProgressHandler('Copying database')
 * })
 * ```
 */
export function createVolumeCopyProgressHandler(
  label: string
): (progress: VolumeCopyProgress) => void {
  return (progress: VolumeCopyProgress) => {
    const formatted = formatVolumeCopyProgress(progress)
    updateProgressLine(`${label}: ${formatted}`)

    if (progress.percentage >= 100) {
      finishProgressLine()
    }
  }
}
