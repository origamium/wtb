/**
 * @fileoverview Prune コマンド実装
 *
 * wtb が作成した (`wtb.managed=true` ラベル付き) Docker volume のうち、
 * もうどの worktree にも属さない「孤児」volume と、中断された atomic overwrite の
 * 残骸 temp volume (`*__wtbtmp_*`) を掃除する。`wtb remove` はデフォルトで volume を
 * 残すため、多数の create/remove を繰り返す並行 worktree ワークフローでは孤児が
 * 溜まる。これがその cleanup primitive。
 *
 * 破壊的 (= データ削除) なので **デフォルトは dry-run** (一覧表示のみ)。実削除は
 * `--yes` が必須。現在コンテナに使用中の volume は削除できない/危険なのでスキップ。
 */

import * as path from "node:path"
import { Command } from "commander"
import { EXIT_CODES } from "../../constants/index.js"
import { loadConfig } from "../../core/config/loader.js"
import { getWtbManagedVolumeNames } from "../../core/docker/client.js"
import {
  findComposeFile,
  readComposeFile,
  resolveComposeProjectName,
} from "../../core/docker/compose.js"
import {
  getContainersUsingVolume,
  removeVolume,
  repoVolumeLabel,
  volumeExists,
} from "../../core/docker/volume.js"
import { getGitRootOrThrow } from "../../core/git/repository.js"
import { listWorktrees } from "../../core/git/worktree.js"
import type { WorktreeInfo } from "../../types/index.js"
import { CLIError } from "../../utils/error.js"
import { withErrorHandling } from "../utils/command-helpers.js"

interface PruneOptions {
  yes?: boolean
  json?: boolean
}

/** 1 つの prune 候補 */
interface PruneCandidate {
  name: string
  /** "orphan" = どの worktree にも属さない / "temp" = 中断された overwrite の残骸 */
  reason: "orphan" | "temp"
  /** コンテナ使用中で削除をスキップしたか */
  inUseBy: string[]
}

/**
 * pruneコマンドを作成
 */
export function pruneCommand(): Command {
  return new Command("prune")
    .description(
      "Remove wtb-managed Docker volumes that are orphaned (belong to no existing worktree) plus leftover temp volumes from interrupted overwrites"
    )
    .option("-y, --yes", "Actually remove the volumes (without this, only previews)")
    .option("--json", "Output machine-readable JSON")
    .action(withErrorHandling(executePruneCommand))
}

/**
 * 現在の各 worktree が使う Compose プロジェクト名の集合を求める。
 * cloned volume は `<project>_<key>` 命名なので、この集合に prefix 一致しない
 * ラベル付き volume は孤児とみなせる。
 */
function liveProjectNames(worktrees: WorktreeInfo[]): Set<string> {
  const projects = new Set<string>()
  for (const wt of worktrees) {
    const composePath = findComposeFile(wt.path)
    let composeConfig = {}
    if (composePath) {
      try {
        composeConfig = readComposeFile(composePath)
      } catch {
        // compose 読めなくても basename ベースで解決する
      }
    }
    try {
      projects.add(resolveComposeProjectName(composeConfig as never, wt.path))
    } catch {
      // resolve 失敗時は何も追加しない (= その worktree のものを孤児扱いしない安全側に倒すため
      // basename を直接足す)
      projects.add(path.basename(wt.path))
    }
  }
  return projects
}

/**
 * ラベル付き volume を prune 候補に分類する。
 * - `*__wtbtmp_*` を含む → "temp" (中断された overwrite の残骸。常に候補)
 * - どの live project にも `<project>_` で前方一致しない → "orphan"
 */
function classifyCandidates(managed: string[], live: Set<string>): PruneCandidate[] {
  const liveList = [...live]
  const candidates: PruneCandidate[] = []
  for (const name of managed) {
    if (name.includes("__wtbtmp_")) {
      candidates.push({ name, reason: "temp", inUseBy: [] })
      continue
    }
    const belongsToLive = liveList.some((p) => name.startsWith(`${p}_`))
    if (!belongsToLive) {
      candidates.push({ name, reason: "orphan", inUseBy: [] })
    }
  }
  return candidates
}

/**
 * pruneコマンドのメイン実行ロジック
 */
async function executePruneCommand(options: PruneOptions): Promise<void> {
  const gitRoot = getGitRootOrThrow()
  // config はロードするが失敗しても prune 自体は volume ラベルに依存するので致命的でない
  try {
    loadConfig(gitRoot)
  } catch {
    // ignore — prune does not need config
  }

  // このリポジトリの volume だけを候補にする (`wtb.repo=<hash>` ラベルで絞る)。同一ホスト上の
  // 別リポジトリの wtb volume を「孤児」と誤認して削除するのを防ぐ。repo ラベルが付く前
  // (v1.1.0 以前) に作られた volume はここに現れず prune 対象外 = fail-safe。
  const managed = getWtbManagedVolumeNames(repoVolumeLabel(gitRoot))

  // SAFETY: a labelled volume is judged "orphan" when it matches no live worktree's
  // project prefix. If worktree enumeration fails (returns []), EVERY volume would
  // look orphaned and `--yes` would delete them all. We're inside a git repo
  // (getGitRootOrThrow passed), so there must be at least the main worktree — an
  // empty list means a git error. Refuse to prune rather than risk mass deletion.
  const worktrees = listWorktrees()
  if (worktrees.length === 0) {
    throw new CLIError(
      "Could not enumerate git worktrees — refusing to prune (every volume would look orphaned). Check `git worktree list`.",
      EXIT_CODES.GENERAL_ERROR
    )
  }

  const live = liveProjectNames(worktrees)
  const candidates = classifyCandidates(managed, live)

  // 使用中の volume は削除できない/危険なのでマークしてスキップ
  for (const c of candidates) {
    c.inUseBy = getContainersUsingVolume(c.name)
  }
  const removable = candidates.filter((c) => c.inUseBy.length === 0)
  const skipped = candidates.filter((c) => c.inUseBy.length > 0)

  if (options.json) {
    const removed: PruneCandidate[] = []
    const failed: PruneCandidate[] = []
    if (options.yes) {
      for (const c of removable) {
        if (safeRemove(c.name)) {
          removed.push(c)
        } else {
          failed.push(c)
        }
      }
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          dryRun: !options.yes,
          candidates: candidates.map((c) => ({
            name: c.name,
            reason: c.reason,
            inUse: c.inUseBy.length > 0,
            inUseBy: c.inUseBy,
          })),
          removed: removed.map((c) => c.name),
          failed: failed.map((c) => c.name),
        },
        null,
        2
      )}\n`
    )
    // 削除失敗は CI が検知できるよう非ゼロで終わらせる。ただし throw すると
    // withErrorHandling が即 process.exit して JSON が壊れる恐れがあるため、
    // payload を書き切ったうえで exitCode のみ設定する。
    if (failed.length > 0) {
      process.exitCode = EXIT_CODES.DOCKER_ERROR
    }
    return
  }

  if (candidates.length === 0) {
    console.log("✨ No orphaned or leftover wtb-managed volumes found.")
    return
  }

  console.log(`🔎 Found ${candidates.length} wtb-managed volume(s) not belonging to any worktree:`)
  for (const c of removable) {
    console.log(`  • ${c.name}  (${c.reason === "temp" ? "leftover temp volume" : "orphaned"})`)
  }
  for (const c of skipped) {
    console.log(`  • ${c.name}  (in use by ${c.inUseBy.join(", ")} — skipped)`)
  }

  if (!options.yes) {
    console.log("")
    console.log(
      `🔍 Dry run — nothing removed. Re-run with --yes to delete the ${removable.length} removable volume(s).`
    )
    return
  }

  console.log("")
  let removedCount = 0
  const failed: string[] = []
  for (const c of removable) {
    if (safeRemove(c.name)) {
      console.log(`  🗑️  Removed ${c.name}`)
      removedCount++
    } else {
      console.log(`  ⚠️  Failed to remove ${c.name}`)
      failed.push(c.name)
    }
  }
  console.log("")
  console.log(
    `✅ Pruned ${removedCount} volume(s)${skipped.length ? `, skipped ${skipped.length} in use` : ""}.`
  )

  // prune --yes は単一目的の破壊的コマンドなので、部分成功を exit 0 で覆い隠さない。
  if (failed.length > 0) {
    throw new CLIError(
      `Failed to remove ${failed.length} volume(s): ${failed.join(", ")}`,
      EXIT_CODES.DOCKER_ERROR
    )
  }
}

/** volume を削除し、実際に消えたか検証する。removeVolume は best-effort で throw
 * しないため、volumeExists で結果を確認する。 */
function safeRemove(name: string): boolean {
  removeVolume(name)
  return !volumeExists(name)
}
