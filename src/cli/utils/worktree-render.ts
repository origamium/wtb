/**
 * @fileoverview Pure renderers for `wtb ls` output formats
 * 入力された WorktreeInfo[] を整形済み文字列に変換する純粋関数群
 */

import * as path from "node:path"
import type { EnrichedWorktreeInfo, WorktreeInfo } from "../../types/index.js"

const CURRENT_MARKER = "→ "
const NO_MARKER = "  "

/**
 * 文字列の「表示幅」（端末カラム数）を返す。East Asian Wide/Fullwidth の文字
 * (CJK 漢字・かな・ハングル・全角記号など) は 2 カラム、それ以外は 1 として数える。
 * ASCII 文字列では `.length` と一致するため、既存の整列挙動は変わらない。
 */
export function visualWidth(value: string): number {
  let width = 0
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0
    width += isWideCodePoint(cp) ? 2 : 1
  }
  return width
}

/** East Asian Wide / Fullwidth に該当する code point か（実用上十分な範囲集合） */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals … CJK Symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK punctuation, etc.
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji / symbols (typically wide)
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+ (astral)
  )
}

/**
 * 右詰めでパディング。表示幅 (visualWidth) で計算するので CJK/全角混じりでも整列する。
 */
function padRight(value: string, width: number): string {
  const visual = visualWidth(value)
  if (visual >= width) return value
  return value + " ".repeat(width - visual)
}

function isCurrentWorktree(wt: WorktreeInfo, currentPath: string): boolean {
  return path.resolve(wt.path) === path.resolve(currentPath)
}

function isMainWorktree(wt: WorktreeInfo, gitRoot: string): boolean {
  return path.resolve(wt.path) === path.resolve(gitRoot)
}

function buildTags(wt: WorktreeInfo, isMain: boolean): string[] {
  const tags: string[] = []
  if (isMain) tags.push("[main]")
  if (wt.locked) tags.push("[locked]")
  if (wt.prunable) tags.push("[prunable]")
  if (wt.bare) tags.push("[bare]")
  return tags
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  if (max <= 1) return value.slice(0, max)
  return `${value.slice(0, max - 1)}…`
}

/**
 * デフォルト（compact）形式
 * 例:
 *   → main            /Users/me/proj                 [main]
 *     feature/api     /Users/me/worktree-feature-api
 */
export function renderDefault(
  rows: WorktreeInfo[],
  currentPath: string,
  gitRoot: string
): string {
  if (rows.length === 0) return "No worktrees found\n"

  const branchWidth = Math.max(...rows.map((r) => visualWidth(r.branch)), "BRANCH".length)
  const pathWidth = Math.max(...rows.map((r) => visualWidth(r.path)), "PATH".length)

  const lines: string[] = []
  for (const wt of rows) {
    const marker = isCurrentWorktree(wt, currentPath) ? CURRENT_MARKER : NO_MARKER
    const tags = buildTags(wt, isMainWorktree(wt, gitRoot))
    const tagsStr = tags.length > 0 ? `  ${tags.join(" ")}` : ""
    lines.push(`${marker}${padRight(wt.branch, branchWidth)}  ${padRight(wt.path, pathWidth)}${tagsStr}`.trimEnd())
  }
  return `${lines.join("\n")}\n`
}

/**
 * 長形式（-l）
 * 列: marker | branch | hash | age | dirty | path | tags | subject
 */
export function renderLong(
  rows: EnrichedWorktreeInfo[],
  currentPath: string,
  gitRoot: string
): string {
  if (rows.length === 0) return "No worktrees found\n"

  const branchWidth = Math.max(...rows.map((r) => visualWidth(r.branch)), "BRANCH".length)
  const hashWidth = Math.max(...rows.map((r) => r.shortHash.length), "COMMIT".length)
  const ageWidth = Math.max(...rows.map((r) => r.ageRelative.length), "AGE".length)
  const pathWidth = Math.max(...rows.map((r) => visualWidth(r.path)), "PATH".length)

  const columns = process.stdout.columns || 120
  const fixedWidth =
    CURRENT_MARKER.length + branchWidth + 2 + hashWidth + 2 + ageWidth + 2 + 2 + 2 + pathWidth + 2
  const subjectBudget = Math.max(20, columns - fixedWidth - 20)

  const header =
    `${NO_MARKER}${padRight("BRANCH", branchWidth)}  ${padRight("COMMIT", hashWidth)}  ${padRight("AGE", ageWidth)}  D  ${padRight("PATH", pathWidth)}  TAGS / SUBJECT`

  const lines: string[] = [header]
  for (const wt of rows) {
    const marker = isCurrentWorktree(wt, currentPath) ? CURRENT_MARKER : NO_MARKER
    const dirty = wt.dirty ? "*" : " "
    const tags = buildTags(wt, isMainWorktree(wt, gitRoot))
    // 拡張情報取得が失敗しているworktree（prunable等）は subject を出さない
    const subject = wt.enrichmentError ? "" : truncate(wt.subject, subjectBudget)
    const trailer = [...tags, subject].filter(Boolean).join(" ")
    lines.push(
      `${marker}${padRight(wt.branch, branchWidth)}  ${padRight(wt.shortHash, hashWidth)}  ${padRight(wt.ageRelative, ageWidth)}  ${dirty}  ${padRight(wt.path, pathWidth)}  ${trailer}`.trimEnd()
    )
  }
  return `${lines.join("\n")}\n`
}

/**
 * パス一覧のみ（スクリプト用途）
 */
export function renderPaths(rows: WorktreeInfo[]): string {
  if (rows.length === 0) return ""
  return `${rows.map((r) => r.path).join("\n")}\n`
}

/**
 * JSON 出力
 */
export function renderJson(
  rows: (WorktreeInfo | EnrichedWorktreeInfo)[],
  currentPath: string,
  gitRoot: string
): string {
  const items = rows.map((wt) => ({
    path: wt.path,
    branch: wt.branch,
    head: wt.head,
    isMain: isMainWorktree(wt, gitRoot),
    isCurrent: isCurrentWorktree(wt, currentPath),
    locked: wt.locked === true,
    prunable: wt.prunable === true,
    bare: wt.bare === true,
    detached: wt.detached === true,
    ...(isEnriched(wt)
      ? {
          shortHash: wt.shortHash,
          subject: wt.subject,
          ageRelative: wt.ageRelative,
          ageTimestamp: wt.ageTimestamp,
          dirty: wt.dirty,
          ...(wt.enrichmentError ? { enrichmentError: wt.enrichmentError } : {}),
        }
      : {}),
  }))
  return JSON.stringify(items, null, 2)
}

function isEnriched(wt: WorktreeInfo | EnrichedWorktreeInfo): wt is EnrichedWorktreeInfo {
  return "shortHash" in wt && typeof (wt as EnrichedWorktreeInfo).shortHash === "string"
}
