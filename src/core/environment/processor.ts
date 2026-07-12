/**
 * @fileoverview 環境変数ファイル処理
 * .envファイルの読み込み、書き込み、値の調整を担当
 */

import { existsSync } from "node:fs"
import * as path from "node:path"
import fs from "fs-extra"
import { BACKUP_EXTENSION, FILE_ENCODING, MAX_TCP_PORT, PORT_RANGE } from "../../constants/index.js"
import type { FileOperationOptions } from "../../types/index.js"
import { atomicWriteFileSync } from "../../utils/atomic-file.js"
import { out } from "../../utils/output.js"

// =============================================================================
// 統合行型（順序保持のため）
// =============================================================================

/**
 * .env ファイルの1行を表す型
 * type === 'entry' は KEY=VALUE 行、type === 'other' はコメント・空行
 */
type EnvLine =
  | { type: "entry"; key: string; value: string; comment?: string }
  | { type: "other"; content: string }

/**
 * 環境変数エントリ（後方互換性のため維持）
 */
interface EnvEntry {
  key: string
  value: string
  comment?: string
}

/**
 * 環境変数ファイルの解析結果
 * lines で元のファイルの行順序を保持
 */
interface ParsedEnvFile {
  /** 行の配列（順序保持） */
  lines: EnvLine[]
  /** エントリ一覧（便利アクセス用） */
  entries: EnvEntry[]
  /** 元のファイル内容（バックアップ用） */
  originalContent: string
}

// =============================================================================
// ポート解決ユーティリティ
// =============================================================================

/**
 * 使用中ポートと衝突しない最小のポートを返す
 * originalPort + 1 から順に空きを探す
 */
function findNextFreePort(originalPort: number, usedPorts: Set<number>): number {
  // Scan originalPort+1 .. MAX_TCP_PORT first.
  for (let c = originalPort + 1; c <= MAX_TCP_PORT; c++) {
    if (!usedPorts.has(c)) return c
  }
  // Wraparound: scan PORT_RANGE.MIN .. originalPort-1 for a free lower port.
  // We deliberately exclude originalPort itself — returning it would be a no-op
  // bump (from === to) and silently allow a shared port.
  for (let c = PORT_RANGE.MIN; c < originalPort; c++) {
    if (!usedPorts.has(c)) return c
  }
  throw new Error(`No free TCP port found for ${originalPort} (all candidate ports are in use)`)
}

// =============================================================================
// パース
// =============================================================================

/**
 * 環境変数ファイルを読み込んで解析
 */
export function parseEnvFile(filePath: string, options?: FileOperationOptions): ParsedEnvFile {
  try {
    if (!existsSync(filePath)) {
      throw new Error(`Environment file not found: ${filePath}`)
    }

    const content = fs.readFileSync(filePath, {
      encoding: options?.encoding || FILE_ENCODING,
    })

    return parseEnvContent(content)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("not found")) {
      throw error
    }
    throw new Error(`Failed to read environment file: ${message}`)
  }
}

/**
 * `KEY=` の右辺を value とインラインコメントに分解する。
 *
 * - 値が引用符で囲まれている場合、閉じ引用符までを value とし、`#` を値の一部として
 *   扱う（旧実装は引用符より前に最初の `#` をコメント扱いしていたため、
 *   `KEY="http://x#frag"` のような値を破壊していた）。閉じ引用符の後ろに `#` があれば
 *   それをコメントとする。
 * - 引用符で囲まれていない場合は、最初の `#` 以降をインラインコメントとして扱う。
 */
function parseEnvValue(rawValue: string): { value: string; comment?: string } {
  const raw = rawValue.trim()
  const quote = raw[0]
  if (quote === '"' || quote === "'") {
    const closeIdx = raw.indexOf(quote, 1)
    if (closeIdx !== -1) {
      const value = raw.slice(1, closeIdx)
      const rest = raw.slice(closeIdx + 1)
      const hashIdx = rest.indexOf("#")
      const comment = hashIdx !== -1 ? rest.slice(hashIdx + 1).trim() || undefined : undefined
      return { value, comment }
    }
    // 閉じ引用符が無い不正な値はそのまま value として保持（コメント解析しない）。
    return { value: rawValue }
  }

  const hashIdx = rawValue.indexOf("#")
  if (hashIdx !== -1) {
    const comment = rawValue.slice(hashIdx + 1).trim() || undefined
    return { value: rawValue.slice(0, hashIdx).trim(), comment }
  }
  return { value: rawValue }
}

/**
 * 環境変数ファイルの内容を解析（行順序を保持）
 */
export function parseEnvContent(content: string): ParsedEnvFile {
  // CRLF / LF どちらの改行でも処理できるよう正規化して分割する。
  // `split("\n")` だけだと CRLF ファイルでは各行に末尾 `\r` が残り、
  // `KEY=VALUE` 正規表現が `$` でマッチせず全エントリが解析対象から漏れてしまう
  // （= ポート調整が無言で no-op になる）。
  const lines = content.split(/\r?\n/)
  const parsedLines: EnvLine[] = []
  const entries: EnvEntry[] = []

  for (const line of lines) {
    const trimmedLine = line.trim()

    // 空行またはコメント行
    if (!trimmedLine || trimmedLine.startsWith("#")) {
      parsedLines.push({ type: "other", content: line })
      continue
    }

    // KEY=VALUE形式の解析
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (match) {
      const [, key, rawValue] = match
      const { value, comment } = parseEnvValue(rawValue)

      const entry: EnvEntry = { key, value, comment }
      parsedLines.push({ type: "entry", key, value, comment })
      entries.push(entry)
    } else {
      // 解析できない行はそのまま保持
      parsedLines.push({ type: "other", content: line })
    }
  }

  return {
    lines: parsedLines,
    entries,
    originalContent: content,
  }
}

// =============================================================================
// シリアライズ（行順序を保持）
// =============================================================================

/**
 * 環境変数エントリを.env形式の文字列に変換
 * 元のファイルの行順序（コメント・空行含む）を保持する
 */
export function serializeEnvFile(parsed: ParsedEnvFile): string {
  const outputLines: string[] = []

  for (const line of parsed.lines) {
    if (line.type === "other") {
      outputLines.push(line.content)
    } else {
      // type === 'entry'
      let serialized = `${line.key}=${line.value}`
      if (line.comment) {
        serialized += ` # ${line.comment}`
      }
      outputLines.push(serialized)
    }
  }

  return outputLines.join("\n")
}

// =============================================================================
// 書き込み
// =============================================================================

/**
 * 環境変数ファイルに設定を書き込み
 */
export function writeEnvFile(
  filePath: string,
  parsed: ParsedEnvFile,
  options?: FileOperationOptions
): void {
  try {
    // バックアップ作成（オプション）
    if (options?.createBackup && existsSync(filePath)) {
      const backupPath = `${filePath}${BACKUP_EXTENSION}`
      fs.copyFileSync(filePath, backupPath)
      out(`📋 Created backup: ${backupPath}`)
    }

    const content = serializeEnvFile(parsed)

    const dir = path.dirname(filePath)
    if (!existsSync(dir)) {
      fs.mkdirpSync(dir)
    }

    atomicWriteFileSync(filePath, content, {
      encoding: options?.encoding || FILE_ENCODING,
    })

    out(`🔧 Wrote environment file: ${filePath}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to write environment file: ${message}`)
  }
}

/** Byte-preserving atomic copy used when env.adjust is empty. */
export function copyEnvFileAtomic(sourcePath: string, targetPath: string): void {
  try {
    const content = fs.readFileSync(sourcePath)
    const sourceMode = fs.statSync(sourcePath).mode & 0o7777
    const dir = path.dirname(targetPath)
    if (!existsSync(dir)) fs.mkdirpSync(dir)
    atomicWriteFileSync(targetPath, content, { mode: sourceMode })
    out(`🔧 Wrote environment file: ${targetPath}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to copy environment file atomically: ${message}`)
  }
}

// =============================================================================
// 調整・コピー
// =============================================================================

/**
 * copyAndAdjustEnvFile が報告する 1 件の値変更 (削除は含まない)。
 */
export interface EnvAdjustmentChange {
  key: string
  from: string
  to: string
}

/**
 * 環境変数ファイルをコピーして値を調整
 * null の削除は Set で管理し、__DELETE__ センチネル値の衝突を防ぐ
 *
 * @param changes - 渡すと string/number/function 調整による値変更 (key/from/to) を
 *   追記する out-parameter。呼び出し側が「どのキーがどのポートになったか」を
 *   表示するために使う (戻り値の件数カウントは従来どおり)。
 * @returns 調整された環境変数の数
 */
export function copyAndAdjustEnvFile(
  sourcePath: string,
  targetPath: string,
  adjustments: Record<string, string | number | null | ((value: string) => string)>,
  options?: FileOperationOptions,
  usedPorts: number[] = [],
  changes?: EnvAdjustmentChange[]
): number {
  const parsed = parseEnvFile(sourcePath, options)
  let adjustedCount = 0

  // 削除対象のキーを Set で管理（センチネル値衝突を防ぐ）
  const keysToDelete = new Set<string>()

  // 数値調整で確保済みのポートを追跡（ファイル内衝突防止 + 引数の usedPorts を加算）
  const assignedPorts = new Set<number>(usedPorts)

  // entries への O(1) ルックアップ用 Map（3回の find() を置き換える）
  const entryByKey = new Map(parsed.entries.map((e) => [e.key, e]))

  // 既存の環境変数を調整
  for (const line of parsed.lines) {
    if (line.type !== "entry") continue

    const adjustment = adjustments[line.key]

    if (adjustment === null) {
      keysToDelete.add(line.key)
      adjustedCount++
    } else if (typeof adjustment === "string") {
      changes?.push({ key: line.key, from: line.value, to: adjustment })
      line.value = adjustment
      // entries 配列も同期
      const entry = entryByKey.get(line.key)
      if (entry) entry.value = adjustment
      adjustedCount++
    } else if (typeof adjustment === "number") {
      const originalValue = parseInt(line.value, 10)
      if (!Number.isNaN(originalValue)) {
        const newPort = findNextFreePort(originalValue, assignedPorts)
        assignedPorts.add(newPort)
        const newValue = newPort.toString()
        changes?.push({ key: line.key, from: line.value, to: newValue })
        line.value = newValue
        const entry = entryByKey.get(line.key)
        if (entry) entry.value = newValue
        adjustedCount++
      }
    } else if (typeof adjustment === "function") {
      const newValue = adjustment(line.value)
      changes?.push({ key: line.key, from: line.value, to: newValue })
      line.value = newValue
      const entry = entryByKey.get(line.key)
      if (entry) entry.value = newValue
      adjustedCount++
    }
  }

  // 削除マークされた行を除去（lines と entries 両方から）
  parsed.lines = parsed.lines.filter(
    (line) => !(line.type === "entry" && keysToDelete.has(line.key))
  )
  parsed.entries = parsed.entries.filter((entry) => !keysToDelete.has(entry.key))

  // 新しい環境変数を追加（既存にない場合のみ）
  const existingKeys = new Set(parsed.entries.map((e) => e.key))
  for (const [key, value] of Object.entries(adjustments)) {
    if (existingKeys.has(key) || value === null || typeof value === "function") continue

    if (typeof value === "number") {
      // 数値調整は「既存のポート値を空きポートにずらす」もの。対象キーがこのファイルに
      // 無い場合、ずらす元のポートが無く、型マーカーの数値（例: 1）をそのまま書くのは
      // 無意味で誤解を招く（PORT=1 のように見える）。追記せず警告だけ出す。
      console.warn(
        `⚠️  env.adjust: "${key}" is a port adjustment but isn't present in this env file — nothing added (a port adjustment needs an existing value to bump). Define ${key} in the file, or use a string value to add a literal.`
      )
      continue
    }

    // string: リテラルとして新キーを追記する（意図的に値を足せる）。
    const strValue = value as string
    const newEntry: EnvEntry = { key, value: strValue, comment: "Added by wtb" }
    parsed.entries.push(newEntry)
    parsed.lines.push({ type: "entry", key, value: strValue, comment: "Added by wtb" })
    adjustedCount++
  }

  writeEnvFile(targetPath, parsed, options)
  return adjustedCount
}
