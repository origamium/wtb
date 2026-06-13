/**
 * @fileoverview Docker Compose スタイルの変数補間
 * スカラー値に対して ${VAR}, ${VAR:-default}, ${VAR-default}, $VAR, $$ をサポート
 */

export interface InterpolationResult {
  /** 補間後の文字列（空文字列になる場合もある） */
  value: string
  /** env 値も利用可能なデフォルトも無い変数名の一覧 */
  unresolved: string[]
}

/**
 * 文字列が未エスケープの $-参照を含むか（安価な事前チェック用）
 */
export function containsVariableReference(raw: string): boolean {
  // $$ はエスケープなので除外し、${ または $ + 識別子文字 だけを true とする
  return /\$(?:\{|[A-Za-z_])/.test(raw)
}

/**
 * Docker Compose 仕様に準拠した変数補間を行う（1 パス）
 *
 * サポートする構文:
 *   $$             → リテラル "$"
 *   ${VAR}         → envMap[VAR]、未設定なら unresolved に記録しテキスト保持
 *   ${VAR:-default}→ 未設定 OR 空なら default、それ以外は envMap[VAR]
 *   ${VAR-default} → 未設定のみ default、空文字でも envMap[VAR]（= ""）を使用
 *   $VAR           → envMap[VAR]、未設定なら "$VAR" そのまま保持 + unresolved に記録
 *
 * 既知の制限:
 *   ネストしたデフォルト（例: ${A:-${B}}）は "${" が default 内に含まれるため
 *   未解決として扱い、変数名を unresolved に記録しテキストを変更しない。
 *   Docker Compose の完全な再帰展開は実装しない。
 */
export function interpolateComposeValue(
  raw: string,
  envMap: Readonly<Record<string, string>>
): InterpolationResult {
  const unresolved: string[] = []

  // Regex で 1 パス置換する。マッチ優先順位:
  //   1. $$           → リテラル "$"
  //   2. ${...}       → ブレース付き参照（デフォルト付き含む）
  //   3. $[A-Za-z_]+ → 裸の変数参照
  const RE = /\$\$|\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g

  const value = raw.replace(
    RE,
    (match, braceContent: string | undefined, bareVar: string | undefined) => {
      // ケース 1: $$ → リテラル "$"
      if (match === "$$") {
        return "$"
      }

      // ケース 2: ${...}
      if (braceContent !== undefined) {
        // ネストした ${ を含む場合は unresolved（既知の制限）
        if (braceContent.includes("${")) {
          // 変数名部分だけを抽出して記録
          const nameMatch = braceContent.match(/^([A-Za-z_][A-Za-z0-9_]*)/)
          if (nameMatch) {
            unresolved.push(nameMatch[1])
          }
          return match
        }

        // ${VAR:?msg} or ${VAR?msg} — required-variable / error syntax.
        // Docker requires the variable to be set (and non-empty for :?).
        // We treat these as UNRESOLVED rather than substituting the message.
        const requiredMatch = braceContent.match(/^([A-Za-z_][A-Za-z0-9_]*):?\?[\s\S]*$/)
        if (requiredMatch) {
          const varName = requiredMatch[1]
          const envVal = envMap[varName]
          if (envVal !== undefined && envVal !== "") return envVal
          unresolved.push(varName)
          return match
        }

        // ${VAR:-default} または ${VAR-default}
        // Tightened: only ":-" or "-" (bare ":" is NOT a valid default separator).
        const separatorMatch = braceContent.match(/^([A-Za-z_][A-Za-z0-9_]*)(:-|-)([\s\S]*)$/)
        if (separatorMatch) {
          const [, varName, separator, defaultVal] = separatorMatch
          const envVal = envMap[varName]
          const isUnset = envVal === undefined
          const isEmpty = envVal === ""

          if (separator === ":-") {
            // 未設定 OR 空 → デフォルト使用
            if (isUnset || isEmpty) return defaultVal
            return envVal
          }
          // separator === "-"（: なし）: 未設定のみデフォルト
          if (isUnset) return defaultVal
          return envVal
        }

        // ${VAR} — デフォルトなし
        const plainVarName = braceContent.trim()
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(plainVarName)) {
          const envVal = envMap[plainVarName]
          if (envVal !== undefined) return envVal
          unresolved.push(plainVarName)
          return match
        }

        // 解析できない場合はそのまま
        return match
      }

      // ケース 3: $VAR（裸の変数）
      if (bareVar !== undefined) {
        const envVal = envMap[bareVar]
        if (envVal !== undefined) return envVal
        unresolved.push(bareVar)
        return match
      }

      return match
    }
  )

  return { value, unresolved }
}
