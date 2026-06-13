/**
 * @fileoverview ポート変更の伝播ユーティリティ（純粋関数のみ、I/O なし）
 * env.adjust で変更されたポート番号を URL 値・Compose デフォルト等に伝播させる
 */

import type { EnvAdjustmentChange } from "./processor.js"

// EnvAdjustmentChange は processor.ts からインポートして再利用
export type { EnvAdjustmentChange }

/** original → new のポートマッピング */
export type PortMap = Map<number, number>

// =============================================================================
// buildPortMap
// =============================================================================

/**
 * EnvAdjustmentChange の配列から PortMap を構築する。
 * from と to の両方が有効なポート番号（1–65535）で、かつ異なる場合のみ含める。
 */
export function buildPortMap(changes: EnvAdjustmentChange[]): PortMap {
  const map: PortMap = new Map()
  for (const change of changes) {
    const from = Number(change.from)
    const to = Number(change.to)
    if (
      Number.isInteger(from) &&
      Number.isInteger(to) &&
      from >= 1 &&
      from <= 65535 &&
      to >= 1 &&
      to <= 65535 &&
      from !== to
    ) {
      map.set(from, to)
    }
  }
  return map
}

// =============================================================================
// propagatePortsInValue
// =============================================================================

/**
 * 文字列中でポートマッピングを適用する。
 *
 * 「`:` の直後にある」かつ「URL/リスト/引用符/EOL の境界が続く」数字のみを対象とする。
 * 裸の数字（前後に `:` がない）は書き換えない。
 *
 * 例: "http://127.0.0.1:54321/path" → "http://127.0.0.1:54322/path"
 *     "TIMEOUT=54321" → そのまま（`:` が前にない）
 *
 * マップのキーが他のキーの部分文字列になるケース（例: 5432 と 54321）は
 * 境界 lookahead により安全に区別する（54321 の後ろに数字があれば 5432 にマッチしない）。
 *
 * 同時マップ（A:54321→54322, B:54322→54323）は元テキストに 1 パスのみ適用するため、
 * A の結果が再度 B にマッチすることはない。
 */
export function propagatePortsInValue(
  value: string,
  map: PortMap
): { value: string; hits: Array<{ from: number; to: number }> } {
  if (map.size === 0) return { value, hits: [] }

  // マップキーを降順でソート（長い番号を先にマッチさせる、部分マッチ防止）
  const portKeys = Array.from(map.keys()).sort((a, b) => b - a)
  const alternation = portKeys.map(String).join("|")

  // lookahead: ポート番号の直後が 数字 でないこと（部分マッチ防止）
  // かつ URL/リスト/引用符/空白/EOL 境界であること
  // ? # @ ) ] > を追加（query string, fragment, authority, close-brackets）
  const re = new RegExp(`(?<=:)(${alternation})(?=[/?#@)\\]>/\\s"'$:,;}]|$)`, "g")

  const hits: Array<{ from: number; to: number }> = []
  const result = value.replace(re, (matched) => {
    const from = Number(matched)
    const to = map.get(from)
    if (to === undefined) return matched
    hits.push({ from, to })
    return String(to)
  })

  return { value: result, hits }
}

// =============================================================================
// propagateComposeDefaults
// =============================================================================

/**
 * Compose ファイルの raw YAML 文字列中の `${VAR:-default}` / `${VAR-default}` を
 * ポート変更に合わせて書き換える。
 *
 * 優先ルール:
 *   1. VAR が envChanges のキーなら → その new 値（envChanges[VAR].to）に置換
 *   2. それ以外で default テキストが portMap の old ポートと完全一致するなら → new 値に置換
 *   3. どちらでもなければ変更しない
 *
 * これにより、env ファイルが読み込まれていなくても、コピーされた Compose が自己整合する。
 */
export function propagateComposeDefaults(
  raw: string,
  envChanges: Record<string, { from: string; to: string }>,
  map: PortMap
): string {
  // ${VAR:-default} と ${VAR-default} の両形式に対応
  // separator グループ: ":-" または "-"
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:?-)([^}]*)\}/g

  return raw.replace(re, (match, varName: string, separator: string, defaultText: string) => {
    // 優先ルール 1: VAR が envChanges に存在する
    if (Object.hasOwn(envChanges, varName)) {
      return `\${${varName}${separator}${envChanges[varName].to}}`
    }

    // 優先ルール 2: default テキストが portMap の old ポートと完全一致
    const defaultPort = Number(defaultText)
    if (
      Number.isInteger(defaultPort) &&
      String(defaultPort) === defaultText &&
      map.has(defaultPort)
    ) {
      const newPort = map.get(defaultPort) as number
      return `\${${varName}${separator}${newPort}}`
    }

    // 変更なし
    return match
  })
}
