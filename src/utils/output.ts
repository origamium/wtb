/**
 * @fileoverview Human/progress 出力の振り分けヘルパー
 *
 * `--json` を持つコマンド (create / reclone 等) は stdout を機械可読な JSON 専用に
 * 保つ必要がある。人間向けの進捗・装飾出力は通常 stdout (console.log 互換) に出すが、
 * JSON モード中は stderr に振り分けることで `wtb create --json | jq` のようなパイプを
 * 壊さない。デフォルト (JSON モード off) では console.log と完全に同一の挙動なので、
 * 既存の人間向け出力はバイト単位で変わらない。
 */

let jsonMode = false

/**
 * JSON 出力モードを切り替える。コマンド action の冒頭で毎回明示的に設定すること
 * (モジュール状態なので、設定し忘れると前回実行のモードを引き継いでしまう)。
 */
export function setJsonOutputMode(enabled: boolean): void {
  jsonMode = enabled
}

/**
 * 現在 JSON 出力モードかどうか。
 */
export function isJsonOutputMode(): boolean {
  return jsonMode
}

/**
 * 人間向けの 1 行を出力する。通常は console.log、JSON モード中は console.error。
 */
export function out(message = ""): void {
  if (jsonMode) {
    console.error(message)
  } else {
    console.log(message)
  }
}

/**
 * 進捗バー等のストリーム書き込み先。通常は stdout、JSON モード中は stderr。
 */
export function outStream(): NodeJS.WriteStream {
  return jsonMode ? process.stderr : process.stdout
}
