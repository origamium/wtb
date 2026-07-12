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
import { resolveRepositoryPath } from "../../core/config/paths.js"
import { getWtbManagedVolumeNamesOrThrow } from "../../core/docker/client.js"
import {
  loadComposeInterpolationEnvironment,
  readComposeFile,
  resolveComposeProjectNameForWorktree,
} from "../../core/docker/compose.js"
import {
  containsVariableReference,
  interpolateComposeValue,
} from "../../core/docker/interpolation.js"
import {
  getContainersUsingVolumeOrThrow,
  getVolumeRecoveryDirectory,
  inspectVolumeOwnership,
  readVolumeRecoveryRecords,
  removeVolumeOrThrow,
  removeVolumeRecoveryRecord,
  repoVolumeLabel,
  resolveVolumeName,
  volumeExistsOrThrow,
  type StoredVolumeRecoveryRecord,
  type VolumeOwnershipInspection,
} from "../../core/docker/volume.js"
import { acquireRepositoryLock, getRepositoryContext } from "../../core/git/repository.js"
import { listWorktrees } from "../../core/git/worktree.js"
import type { WorktreeInfo } from "../../types/index.js"
import { CLIError } from "../../utils/error.js"
import { withErrorHandling } from "../utils/command-helpers.js"

interface PruneOptions {
  yes?: boolean
  json?: boolean
  discardRecovery?: boolean
}

/** 1 つの prune 候補 */
interface PruneCandidate {
  name: string
  /** "orphan" = どの worktree にも属さない / "temp" = 中断された overwrite の残骸 */
  reason: "orphan" | "temp"
  /** コンテナ使用中で削除をスキップしたか */
  inUseBy: string[]
  /** 明示的な --discard-recovery で一緒に削除する復旧記録。 */
  recovery?: StoredVolumeRecoveryRecord
  /** Ownership snapshot revalidated immediately before destructive removal. */
  ownership: VolumeOwnershipInspection
}

interface LiveVolumeOwners {
  projects: Set<string>
  branches: Set<string>
  /** Exact external volume names referenced by any live worktree Compose file. */
  externalVolumes: Set<string>
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
    .option(
      "--discard-recovery",
      "Discard protected recovery temp volumes and records (requires --yes)"
    )
    .option("--json", "Output machine-readable JSON, including protected recovery volumes")
    .action(withErrorHandling(executePruneCommand))
}

/**
 * main 設定の docker_compose_file を各 worktree に対して正確に解決し、live owner を
 * 作る。自動探索や basename fallback は行わない。1 件でも読めなければ全 prune を
 * 中止し、現役 volume を孤児と誤認しないよう fail-closed にする。
 */
function liveVolumeOwners(
  worktrees: WorktreeInfo[],
  composeFile: string
): LiveVolumeOwners {
  if (!composeFile) {
    throw new CLIError(
      "Main configuration has no docker_compose_file — refusing to prune because live Compose projects cannot be resolved.",
      EXIT_CODES.GENERAL_ERROR
    )
  }
  const projects = new Set<string>()
  const branches = new Set<string>()
  const externalVolumes = new Set<string>()
  for (const wt of worktrees) {
    let composePath = `${wt.path}/${composeFile}`
    try {
      composePath = resolveRepositoryPath(wt.path, composeFile, {
        field: "docker_compose_file",
        rejectSymlinkAncestors: true,
      })
      const composeConfig = readComposeFile(composePath)
      const project = resolveComposeProjectNameForWorktree(
        composeConfig,
        wt.path,
        process.env,
        path.dirname(composePath)
      )
      // A one-shot shell override must only widen liveness. Also resolve the
      // checked-in/.env baseline without process variables so
      // COMPOSE_PROJECT_NAME=temporary cannot make legacy volumes disappear.
      const baselineProject = resolveComposeProjectNameForWorktree(
        composeConfig,
        wt.path,
        {},
        path.dirname(composePath)
      )
      if (!project || !baselineProject || !wt.branch) {
        throw new Error("empty Compose project or branch")
      }
      projects.add(project)
      projects.add(baselineProject)
      branches.add(wt.branch)

      // Containers are not an authority for liveness: a stopped stack still owns every external
      // volume declared by its checked-out Compose file. Resolve the exact name with the same
      // worktree dotenv/process environment used by Compose project-name resolution. Any
      // unresolved interpolation aborts the whole prune instead of silently dropping protection.
      const interpolationEnvironments = [
        loadComposeInterpolationEnvironment(wt.path, {}),
        loadComposeInterpolationEnvironment(wt.path, process.env),
      ]
      for (const volumeKey of Object.keys(composeConfig.volumes ?? {})) {
        const resolved = resolveVolumeName(composeConfig, volumeKey, project)
        if (!resolved?.external) continue
        for (const interpolationEnvironment of interpolationEnvironments) {
          const interpolation = interpolateComposeValue(
            resolved.name,
            interpolationEnvironment
          )
          if (
            interpolation.unresolved.length > 0 ||
            containsVariableReference(interpolation.value) ||
            interpolation.value.trim().length === 0
          ) {
            const unresolved = interpolation.unresolved.join(", ") || resolved.name
            throw new Error(
              `external volume '${volumeKey}' has an unresolved name (${unresolved})`
            )
          }
          externalVolumes.add(interpolation.value)
        }
      }
    } catch (error) {
      throw new CLIError(
        `Could not resolve Compose project for worktree '${wt.path}' from '${composePath}' — refusing to prune: ${error instanceof Error ? error.message : String(error)}`,
        EXIT_CODES.GENERAL_ERROR
      )
    }
  }
  return { projects, branches, externalVolumes }
}

/**
 * ラベル付き volume を prune 候補に分類する。
 * - `*__wtbtmp_*` を含む → "temp" (中断された overwrite の残骸。常に候補)
 * - どの live project にも `<project>_` で前方一致しない → "orphan"
 */
function classifyCandidates(
  managed: Array<{ name: string; ownership: VolumeOwnershipInspection }>,
  live: LiveVolumeOwners,
  recoveryByTemp: Map<string, StoredVolumeRecoveryRecord>,
  discardRecovery: boolean
): { candidates: PruneCandidate[]; protectedRecords: StoredVolumeRecoveryRecord[] } {
  const liveList = [...live.projects]
  const candidates: PruneCandidate[] = []
  const protectedRecords: StoredVolumeRecoveryRecord[] = []
  for (const { name, ownership } of managed) {
    const recovery = recoveryByTemp.get(name)
    const hasExactOwner = ownership.project !== undefined && ownership.branch !== undefined
    const isLegacyTemp =
      !hasExactOwner && /__wtbtmp_\d+_\d+_[a-z0-9]+$/i.test(name)
    const isTemp = ownership.temp || isLegacyTemp
    // The durable recovery record is the authority for protection. A missing or
    // altered temp label must never downgrade the only verified recovery copy into
    // an ordinary orphan that `prune --yes` can delete.
    if (recovery && !discardRecovery) {
      protectedRecords.push(recovery)
      continue
    }
    // Exact external references are live even when every Compose container is stopped. This
    // check intentionally precedes temp/orphan classification because the checked-out Compose
    // declaration is stronger liveness evidence than a stale ownership/temp label.
    if (live.externalVolumes.has(name)) continue
    if (isTemp) {
      candidates.push({ name, reason: "temp", inUseBy: [], recovery, ownership })
      continue
    }

    // 新形式はラベルで完全一致する worktree owner を判定する。ラベルが揃わない旧形式
    // だけ、従来の `<project>_` prefix 判定へフォールバックする。
    const belongsToLive = hasExactOwner
      ? live.projects.has(ownership.project as string) ||
        live.branches.has(ownership.branch as string)
      : liveList.some((project) => name.startsWith(`${project}_`))
    if (!belongsToLive) {
      candidates.push({ name, reason: "orphan", inUseBy: [], ownership })
    }
  }
  return { candidates, protectedRecords }
}

/**
 * pruneコマンドのメイン実行ロジック
 */
async function executePruneCommand(options: PruneOptions): Promise<void> {
  if (options.discardRecovery && !options.yes) {
    throw new CLIError("--discard-recovery requires --yes", EXIT_CODES.GENERAL_ERROR)
  }

  const repository = getRepositoryContext()
  // A destructive prune must share create's repository lock. Otherwise a
  // branch can be recreated after the liveness snapshot but before volume
  // removal, turning its just-adopted data volume into a stale candidate.
  const releaseRepositoryLock = options.yes
    ? await acquireRepositoryLock(repository)
    : undefined
  try {
    await executePruneWithRepository(options, repository)
  } finally {
    if (releaseRepositoryLock) await releaseRepositoryLock()
  }
}

async function executePruneWithRepository(
  options: PruneOptions,
  repository: ReturnType<typeof getRepositoryContext>
): Promise<void> {
  const { mainRoot, commonGitDir } = repository
  // main worktree の設定が正本。設定エラーを握り潰すと custom compose path を見失い、
  // 現役 volume を orphan と誤判定するため必ず伝播させる。
  const config = loadConfig(mainRoot)
  const repo = repoVolumeLabel(mainRoot)

  // Docker 問い合わせ失敗を空リストとして成功扱いにしない strict API。
  const managedNames = getWtbManagedVolumeNamesOrThrow(repo)

  // SAFETY: a labelled volume is judged "orphan" when it matches no live worktree's
  // project prefix. If worktree enumeration fails (returns []), EVERY volume would
  // look orphaned and `--yes` would delete them all. We're inside a git repo
  // (getGitRootOrThrow passed), so there must be at least the main worktree — an
  // empty list means a git error. Refuse to prune rather than risk mass deletion.
  const worktrees = listWorktrees(mainRoot)
  if (worktrees.length === 0) {
    throw new CLIError(
      "Could not enumerate git worktrees — refusing to prune (every volume would look orphaned). Check `git worktree list`.",
      EXIT_CODES.GENERAL_ERROR
    )
  }

  const live = liveVolumeOwners(worktrees, config.docker_compose_file)
  const recoveryDirectory = getVolumeRecoveryDirectory(commonGitDir)
  const recoveryRecords = readVolumeRecoveryRecords(recoveryDirectory)
  const recoveryByTemp = new Map<string, StoredVolumeRecoveryRecord>()
  for (const stored of recoveryRecords) {
    if (stored.record.ownership.repo !== repo) {
      throw new CLIError(
        `Recovery record '${stored.path}' belongs to another repository — refusing to prune.`,
        EXIT_CODES.GENERAL_ERROR
      )
    }
    if (recoveryByTemp.has(stored.record.tempVolume)) {
      throw new CLIError(
        `Multiple recovery records reference '${stored.record.tempVolume}' — refusing to prune.`,
        EXIT_CODES.GENERAL_ERROR
      )
    }
    recoveryByTemp.set(stored.record.tempVolume, stored)
  }

  const managed = managedNames.map((name) => {
    const ownership = inspectVolumeOwnership(name)
    // docker volume ls の label filter を防御的に再検証する。結果が矛盾した状態では
    // 何も削除しない。
    if (!ownership.managed || ownership.repo !== repo) {
      throw new CLIError(
        `Volume '${name}' does not have the expected wtb repository ownership labels — refusing to prune.`,
        EXIT_CODES.GENERAL_ERROR
      )
    }
    return { name, ownership }
  })

  const { candidates } = classifyCandidates(
    managed,
    live,
    recoveryByTemp,
    options.discardRecovery === true
  )
  const missingRecoveryRecords: StoredVolumeRecoveryRecord[] = []
  if (options.discardRecovery === true) {
    for (const stored of recoveryRecords) {
      if (!volumeExistsOrThrow(stored.record.tempVolume)) {
        missingRecoveryRecords.push(stored)
        continue
      }
      const candidate = candidates.find((entry) => entry.recovery?.path === stored.path)
      const expected = stored.record.ownership
      if (
        !candidate?.ownership.managed ||
        !candidate.ownership.temp ||
        candidate.ownership.repo !== expected.repo ||
        candidate.ownership.project !== expected.project ||
        candidate.ownership.branch !== expected.branch
      ) {
        throw new CLIError(
          `Recovery temp '${stored.record.tempVolume}' exists but no longer has the exact managed temp ownership recorded for recovery — refusing to discard it.`,
          EXIT_CODES.GENERAL_ERROR
        )
      }
    }
  }
  // volume が既に手動削除されていても record 自体は「未解決の復旧状態」なので表示する。
  const protectedRecords = options.discardRecovery === true ? [] : recoveryRecords

  // 使用状況を全候補について strict に事前取得してから 1 件目を削除する。途中の Docker
  // 問い合わせ失敗で、残りを「未使用」とみなして部分削除しない。
  for (const c of candidates) {
    c.inUseBy = getContainersUsingVolumeOrThrow(c.name)
  }
  const removable = candidates.filter((c) => c.inUseBy.length === 0)
  const skipped = candidates.filter((c) => c.inUseBy.length > 0)

  if (options.json) {
    const removed: PruneCandidate[] = []
    const failed: PruneCandidate[] = []
    const failedRecoveryRecords: string[] = []
    if (options.yes) {
      for (const c of removable) {
        if (safeRemove(c)) {
          removed.push(c)
        } else {
          failed.push(c)
        }
      }
      for (const stored of missingRecoveryRecords) {
        try {
          removeVolumeRecoveryRecord(stored.path)
        } catch {
          failedRecoveryRecords.push(stored.record.tempVolume)
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
          protected: protectedRecords.map((stored) => stored.record.tempVolume),
          removed: removed.map((c) => c.name),
          failed: [...failed.map((c) => c.name), ...failedRecoveryRecords],
        },
        null,
        2
      )}\n`
    )
    // 削除失敗は CI が検知できるよう非ゼロで終わらせる。ただし throw すると
    // withErrorHandling が即 process.exit して JSON が壊れる恐れがあるため、
    // payload を書き切ったうえで exitCode のみ設定する。
    if (failed.length > 0 || failedRecoveryRecords.length > 0) {
      process.exitCode = EXIT_CODES.DOCKER_ERROR
    }
    return
  }

  if (
    candidates.length === 0 &&
    protectedRecords.length === 0 &&
    missingRecoveryRecords.length === 0
  ) {
    console.log("✨ No orphaned or leftover wtb-managed volumes found.")
    return
  }

  if (protectedRecords.length > 0) {
    console.log(
      `🔒 Protected ${protectedRecords.length} recovery temp volume(s); use --yes --discard-recovery only after recovery is no longer needed:`
    )
    for (const stored of protectedRecords) {
      console.log(
        `  • ${stored.record.tempVolume}  (recovery for ${stored.record.targetVolume})`
      )
    }
  }

  if (candidates.length > 0) {
    console.log(
      `🔎 Found ${candidates.length} wtb-managed volume(s) not belonging to any worktree:`
    )
  }
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
    if (safeRemove(c)) {
      console.log(`  🗑️  Removed ${c.name}`)
      removedCount++
    } else {
      console.log(`  ⚠️  Failed to remove ${c.name}`)
      failed.push(c.name)
    }
  }
  for (const stored of missingRecoveryRecords) {
    try {
      removeVolumeRecoveryRecord(stored.path)
    } catch {
      failed.push(stored.record.tempVolume)
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

/** volume を削除して strict に不在を確認し、対応する復旧記録は成功後だけ消す。 */
function safeRemove(candidate: PruneCandidate): boolean {
  try {
    const current = inspectVolumeOwnership(candidate.name)
    if (!sameOwnershipSnapshot(current, candidate.ownership)) return false
    removeVolumeOrThrow(candidate.name)
    if (volumeExistsOrThrow(candidate.name)) return false
    if (candidate.recovery) {
      removeVolumeRecoveryRecord(candidate.recovery.path)
    }
    return true
  } catch {
    return false
  }
}

function sameOwnershipSnapshot(
  current: VolumeOwnershipInspection,
  expected: VolumeOwnershipInspection
): boolean {
  const currentLabels = Object.entries(current.labels).sort(([a], [b]) => a.localeCompare(b))
  const expectedLabels = Object.entries(expected.labels).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(currentLabels) === JSON.stringify(expectedLabels)
}
