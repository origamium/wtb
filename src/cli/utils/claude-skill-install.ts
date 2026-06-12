/**
 * @fileoverview Claude Code Skill テンプレートを展開するヘルパー
 */

import { existsSync, lstatSync, readFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import fs from "fs-extra"
import { APP_VERSION } from "../../constants/index.js"
import { getGitRoot, isGitRepository } from "../../core/git/repository.js"

export interface InstallOptions {
  /** 既存ファイルを上書き */
  force?: boolean
  /** ~/.claude/skills/wtb/ に配置 */
  user?: boolean
  /** 書き込まずに対象パスだけ返す */
  dryRun?: boolean
}

export interface InstallResult {
  /** 展開されたスキルのルートディレクトリ */
  targetDir: string
  /** 書き出した SKILL.md の絶対パス */
  skillPath: string
  /** 既存 SKILL.md があったか */
  existed: boolean
  /** 実際に書き込んだか（dryRun / skip の場合 false） */
  wrote: boolean
  /** スキップ理由（existed && !force）または null */
  skippedReason: string | null
}

/** `wtb init-claude --check` の結果 */
export interface SkillCheckResult {
  /** チェック対象の SKILL.md 絶対パス */
  skillPath: string
  /** SKILL.md が存在するか */
  installed: boolean
  /** インストール済みファイルの version stamp（無ければ null） */
  installedVersion: string | null
  /** この CLI に同梱されているバージョン (= APP_VERSION) */
  bundledVersion: string
  /** 未インストール / stamp なし / バージョン不一致なら true */
  stale: boolean
}

/**
 * インストール時に frontmatter 直後へ差し込む version stamp。
 * frontmatter のキーを増やすと Claude Code のローダー警告のリスクがあるため、
 * HTML コメント形式にする。
 */
const SKILL_VERSION_STAMP_RE = /<!--\s*wtb-skill-version:\s*(\S+)\s*-->/

/** SKILL.md 先頭の frontmatter ブロック (`---` ... `---`) */
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n/

/**
 * SKILL.md の内容から version stamp を取り出す（無ければ null）
 */
export function parseSkillVersion(content: string): string | null {
  const match = SKILL_VERSION_STAMP_RE.exec(content)
  return match ? match[1] : null
}

/**
 * テンプレート内容の frontmatter 直後に version stamp を差し込む
 */
export function stampSkillContent(template: string, version: string): string {
  const stamp = `<!-- wtb-skill-version: ${version} -->\n`
  const match = FRONTMATTER_RE.exec(template)
  if (!match) {
    return stamp + template
  }
  const head = template.slice(0, match[0].length)
  return `${head}${stamp}${template.slice(match[0].length)}`
}

/**
 * インストール済み SKILL.md の鮮度を判定する（書き込みは一切しない）。
 * stamp が無い（= stamp 導入前のインストール）場合も stale 扱いにする。
 */
export function checkClaudeSkill(
  opts: Pick<InstallOptions, "user">,
  cwd?: string
): SkillCheckResult {
  const targetDir = resolveTargetDir(opts, cwd)
  const skillPath = path.join(targetDir, "SKILL.md")

  if (!existsSync(skillPath)) {
    return {
      skillPath,
      installed: false,
      installedVersion: null,
      bundledVersion: APP_VERSION,
      stale: true,
    }
  }

  const installedVersion = parseSkillVersion(readFileSync(skillPath, "utf-8"))
  return {
    skillPath,
    installed: true,
    installedVersion,
    bundledVersion: APP_VERSION,
    stale: installedVersion !== APP_VERSION,
  }
}

/**
 * skip 経路で返す理由文字列。バージョンが古い/不明なときは stale を明示し、
 * --force での更新を促す。
 */
function buildSkippedReason(skillPath: string): string {
  const installedVersion = parseSkillVersion(readFileSync(skillPath, "utf-8"))
  if (installedVersion === APP_VERSION) {
    return "already exists (use --force to overwrite)"
  }
  const installed = installedVersion ? `v${installedVersion}` : "unstamped"
  return `stale (installed ${installed}, bundled v${APP_VERSION}) — re-run with --force`
}

/**
 * templates ルート（npm パッケージ同梱）
 * src/cli/utils/claude-skill-install.(ts|js) から見た相対パス
 */
function resolveTemplateRoot(): string {
  const here = fileURLToPath(import.meta.url)
  // dist/cli/utils/claude-skill-install.js から ../../../templates
  // src/cli/utils/claude-skill-install.ts から同様
  return path.resolve(path.dirname(here), "..", "..", "..", "templates")
}

function resolveTemplateSkillFile(): string {
  return path.join(resolveTemplateRoot(), "claude", "skills", "wtb", "SKILL.md")
}

/**
 * インストール先ディレクトリを決定する
 * --user: ~/.claude/skills/wtb
 * default: <gitRoot>/.claude/skills/wtb
 */
export function resolveTargetDir(opts: InstallOptions, cwd?: string): string {
  if (opts.user) {
    return path.join(os.homedir(), ".claude", "skills", "wtb")
  }
  if (!isGitRepository(cwd)) {
    throw new Error("Not in a git repository (use --user to install globally)")
  }
  const root = getGitRoot(cwd)
  return path.join(root, ".claude", "skills", "wtb")
}

/**
 * SKILL.md を target に展開する
 */
export async function installClaudeSkill(
  opts: InstallOptions,
  cwd?: string
): Promise<InstallResult> {
  const targetDir = resolveTargetDir(opts, cwd)
  const skillPath = path.join(targetDir, "SKILL.md")
  const templatePath = resolveTemplateSkillFile()

  if (!existsSync(templatePath)) {
    throw new Error(`Skill template not found at: ${templatePath}`)
  }

  const existed = existsSync(skillPath)

  if (opts.dryRun) {
    return {
      targetDir,
      skillPath,
      existed,
      wrote: false,
      skippedReason: null,
    }
  }

  if (existed && !opts.force) {
    return {
      targetDir,
      skillPath,
      existed: true,
      wrote: false,
      skippedReason: buildSkippedReason(skillPath),
    }
  }

  // symlink 経由で書き込まれるのを防ぐ
  if (existed) {
    const stat = lstatSync(skillPath)
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlink at ${skillPath}. Remove it manually first.`)
    }
  }

  // テンプレートを素のままコピーせず、frontmatter 直後に version stamp を差し込む。
  // この stamp が skip 経路と `init-claude --check` の staleness 判定の根拠になる。
  await fs.ensureDir(targetDir)
  const template = await fs.readFile(templatePath, "utf-8")
  await fs.writeFile(skillPath, stampSkillContent(template, APP_VERSION), "utf-8")

  return {
    targetDir,
    skillPath,
    existed,
    wrote: true,
    skippedReason: null,
  }
}
