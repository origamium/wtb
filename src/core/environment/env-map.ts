/**
 * @fileoverview worktree 用の環境変数マップ構築
 * config.env.file に列挙された全ファイルを読み込み、全キーを含む Record を返す
 */

import * as path from "node:path"
import type { WtbConfig } from "../../types/index.js"
import { parseEnvFile } from "./processor.js"

/**
 * worktreePath を基準に config.env.file の各ファイルを読み込み、
 * 全キー → 値 の Record を返す。
 *
 * - 後のファイルが同名キーを上書きする（last-wins、collectEnvValues と同じ動作）
 * - 存在しない・読み取れないファイルは無視する（worktree が未作成の場合がある）
 */
export function buildWorktreeEnvMap(
  worktreePath: string,
  config: WtbConfig
): Record<string, string> {
  const result: Record<string, string> = {}

  for (const relPath of config.env.file) {
    const absPath = path.resolve(worktreePath, relPath)
    try {
      const parsed = parseEnvFile(absPath)
      for (const entry of parsed.entries) {
        result[entry.key] = entry.value
      }
    } catch {
      // ファイルが存在しない・読み取れない場合は無視
    }
  }

  return result
}
