/**
 * @fileoverview Remove コマンド実装
 * Git worktreeの削除を担当
 */

import { existsSync } from "node:fs"
import * as path from "node:path"
import { Command } from "commander"
import { EXIT_CODES } from "../../constants/index.js"
import { loadConfig } from "../../core/config/loader.js"
import { resolveRepositoryPath } from "../../core/config/paths.js"
import {
  assertComposeStorageDefinitionsSafe,
  composeDown,
  readComposeFile,
  safeResolveComposeProjectName,
  withComposeSnapshot,
} from "../../core/docker/compose.js"
import {
  assertComposeProjectUnique,
  assertDockerComposeProjectOwnedByWorktree,
  DockerComposeProjectInspectionError,
} from "../../core/docker/project-ownership.js"
import {
  assertComposeVolumesSafeForRemoval,
  DockerVolumeInspectionError,
} from "../../core/docker/volume-removal.js"
import { acquireRepositoryLock, getRepositoryContext } from "../../core/git/repository.js"
import {
  clearSkipWorktree,
  gitHashObject,
  isSamePath,
  listSkipWorktreePaths,
  listWorktrees,
  loadWtbManagedManifest,
  markSkipWorktreeIfTracked,
  removeWorktree,
} from "../../core/git/worktree.js"
import { CLIError, getErrorMessage } from "../../utils/error.js"
import { execGitSafe, executeLifecycleCommand } from "../../utils/exec.js"
import { out, setJsonOutputMode } from "../../utils/output.js"
import { withErrorHandling } from "../utils/command-helpers.js"

interface RemoveOptions {
  force?: boolean
  docker?: boolean
  end?: boolean
  removeVolumes?: boolean
  json?: boolean
}

/** --json 用: Docker Compose teardown の結果。docker_compose_file 未設定なら null。 */
interface ComposeDownOutcome {
  ran: boolean
  failed: boolean
  volumesRemoved: boolean
  skippedReason:
    | "no-docker-flag"
    | "end-command"
    | "same-project"
    | "unresolvable-project"
    | "compose-file-missing"
    | "volume-ownership"
    | null
}

interface EndCommandOutcome {
  ran: boolean
  failed: boolean
  error?: string
}

/**
 * removeコマンドを作成
 */
export function removeCommand(): Command {
  return new Command("remove")
    .description("Remove a git worktree for the specified branch")
    .argument("<branch>", "Branch name of the worktree to remove")
    .option(
      "-f, --force",
      "Force removal despite dirty files or cleanup failure (cleanup failure still exits non-zero)"
    )
    .option("--no-docker", "Skip Docker Compose teardown")
    .option("--no-end", "Skip end_command execution")
    .option(
      "--remove-volumes",
      "Also delete this worktree's Docker volumes (docker compose down -v). No effect when teardown is skipped (--no-docker, or end_command is set — your end_command must drop volumes itself)"
    )
    .option(
      "--json",
      "Always output one JSON result with removed, cleanup outcomes, cleanupErrors, and ok"
    )
    .action(withErrorHandling(executeRemoveCommand))
}

/**
 * removeコマンドのメイン実行ロジック
 */
async function executeRemoveCommand(branch: string, options: RemoveOptions): Promise<void> {
  // モジュール状態なので毎回明示的に設定する (前回実行のモードを引き継がない)。
  const json = options.json === true
  setJsonOutputMode(json)

  let worktreePath: string | null = null
  let composeDownOutcome: ComposeDownOutcome | null = null
  let endCommandOutcome: EndCommandOutcome | null = null
  const cleanupErrors: string[] = []
  let composeCleanupDockerFailure = false
  let removed = false
  let jsonWritten = false

  const writeJsonResult = (): void => {
    if (!json || jsonWritten) return
    jsonWritten = true
    process.stdout.write(
      `${JSON.stringify(
        {
          branch,
          path: worktreePath,
          removed,
          forced: options.force === true,
          composeDown: composeDownOutcome,
          endCommand: endCommandOutcome,
          cleanupErrors,
          ok: removed && cleanupErrors.length === 0,
        },
        null,
        2
      )}\n`
    )
  }

  const stopWithError = (message: string, exitCode: number): void => {
    if (!cleanupErrors.includes(message)) cleanupErrors.push(message)
    if (json) {
      writeJsonResult()
      process.exitCode = exitCode
      return
    }
    throw new CLIError(message, exitCode)
  }

  let context: ReturnType<typeof getRepositoryContext>
  try {
    context = getRepositoryContext()
  } catch (error) {
    stopWithError(
      getErrorMessage(error),
      error instanceof CLIError ? error.exitCode : EXIT_CODES.GENERAL_ERROR
    )
    return
  }
  const gitRoot = context.mainRoot

  let worktrees: ReturnType<typeof listWorktrees>
  try {
    worktrees = listWorktrees(gitRoot)
  } catch (error) {
    stopWithError(
      `Could not enumerate git worktrees: ${getErrorMessage(error)}`,
      EXIT_CODES.GENERAL_ERROR
    )
    return
  }
  const target = worktrees.find((wt) => wt.branch === branch)

  if (!target) {
    console.error("Available worktrees:")
    for (const wt of worktrees) console.error(`  ${wt.branch}: ${wt.path}`)
    stopWithError(`No worktree found for branch '${branch}'`, EXIT_CODES.GENERAL_ERROR)
    return
  }
  worktreePath = target.path

  // main / locked worktree は destructive cleanup より前に拒否する。locked worktree は
  // git worktree remove --force 1 回でも削除できず、先に down/end を走らせると環境だけ壊れる。
  if (isSamePath(worktreePath, gitRoot)) {
    stopWithError("Cannot remove the main repository worktree", EXIT_CODES.GENERAL_ERROR)
    return
  }
  if (target.locked) {
    stopWithError(
      `Worktree for '${branch}' is locked; run 'git worktree unlock ${worktreePath}' before removing it`,
      EXIT_CODES.GENERAL_ERROR
    )
    return
  }

  out(`🗑️  Removing worktree for branch: ${branch}`)
  out(`📂 Worktree path: ${worktreePath}`)

  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig(gitRoot)
  } catch (error) {
    const message = getErrorMessage(error)
    stopWithError(message, error instanceof CLIError ? error.exitCode : EXIT_CODES.CONFIG_ERROR)
    return
  }

  // wtb-managed ファイルの per-worktree 書き換えは (skip-worktree を解除すると)
  // `git worktree remove` を modified ファイル扱いで拒否させる。dirty チェックで
  // 「真のユーザー変更は無い」と確認できた場合に限り、最終的な git 削除を force する。
  // (ユーザー編集や未追跡ファイルがあれば下のチェックが先に throw する。)
  let forceGitRemoval = options.force === true
  const managedByNormalized = new Map<string, string>()
  const normalizeRel = (p: string): string => {
    const n = path.normalize(p)
    return n.startsWith(`.${path.sep}`) ? n.slice(2) : n
  }
  const restoreManagedSkipFlags = (): void => {
    for (const [normalized, sha] of managedByNormalized) {
      if (gitHashObject(worktreePath, normalized) === sha) {
        if (!markSkipWorktreeIfTracked(normalized, worktreePath)) {
          const message = `Failed to restore skip-worktree for managed file '${normalized}'`
          if (!cleanupErrors.includes(message)) cleanupErrors.push(message)
          out(`  ⚠️  ${message}`)
        }
      }
    }
  }
  const inspectWorktreeChanges = (): string[] => {
    // Hash every managed path on every inspection, rather than only paths surfaced by status.
    // This makes the final pre-remove check independently verify wtb's exact bytes even if Git's
    // status cache fails to report a path. Blob hashes omit executable/type bits, so pair the hash
    // with diff --summary, which reports mode/type changes but stays empty for content-only diffs.
    const managedIntegrity = new Map<string, boolean>()
    for (const [relativePath, recordedSha] of managedByNormalized) {
      const shaMatches = gitHashObject(worktreePath, relativePath) === recordedSha
      let modeMatches = false
      try {
        modeMatches =
          execGitSafe(["diff", "--summary", "--", relativePath], { cwd: worktreePath }).trim()
            .length === 0
      } catch {
        // Git I/O failure cannot be treated as proof that the mode is unchanged.
        modeMatches = false
      }
      managedIntegrity.set(relativePath, shaMatches && modeMatches)
    }

    // core.quotePath=false: 非 ASCII のパス (例 `.env.日本語`) を git が 8 進エスケープ +
    // ダブルクオートで返すと managed 一致が外れ、sha が一致していても常に dirty 判定になる。
    const status = execGitSafe(["-c", "core.quotePath=false", "status", "--porcelain"], {
      cwd: worktreePath,
      // porcelain v1 uses a leading space to encode an unchanged index. The generic helper
      // normally trims stdout; preserve it so unstaged changes cannot look staged or malformed.
      preserveLeadingWhitespace: true,
    })
    const reallyDirty = status
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((line) => {
        // porcelain v1: 先頭 2 文字が status (XY)、その後にパス。rename 等の複雑系は
        // managed 一致から外れるため、保守的に dirty として残る。
        const filePath = normalizeRel(line.slice(2).trim())
        if (!managedByNormalized.has(filePath)) return true
        // Staged/index changes are always user changes. Only wtb's plain unstaged content rewrite
        // may be ignored, and only after the independent SHA + mode verification above passed.
        if (line[0] !== " " || line[1] !== "M") return true
        return managedIntegrity.get(filePath) !== true
      })

    // An integrity mismatch must fail closed even if it was absent from status (for example due
    // to a racy stat cache). Synthetic entries are diagnostics only; callers need non-emptiness.
    for (const [relativePath, intact] of managedIntegrity) {
      if (!intact) reallyDirty.push(`!! ${relativePath} (managed content or mode changed)`)
    }
    return reallyDirty
  }

  // A corrupt manifest is never equivalent to an empty manifest. It may be the only record of
  // tracked files hidden by skip-worktree, so even --force must fail closed before cleanup.
  let managed: ReturnType<typeof loadWtbManagedManifest>
  try {
    managed = loadWtbManagedManifest(worktreePath)
  } catch (error) {
    stopWithError(
      `Cannot safely inspect wtb-managed files: ${getErrorMessage(error)}. Repair or remove the corrupt per-worktree manifest only after inspecting the worktree manually.`,
      EXIT_CODES.GENERAL_ERROR
    )
    return
  }

  // manifest が無い / valid だが一部 entry が欠けている場合でも、index 側の
  // skip-worktree は `git status` から変更を隠し続ける。manifest 外の S-bit を 1 件でも
  // 許すと、ユーザーがそのファイルを編集していても remove (特に --force) が検知できず
  // worktree ごと失う。全 S-bit を Git から直接列挙し、wtb の manifest で説明できない
  // path があれば index を変更する前・cleanup を走らせる前に fail-closed で拒否する。
  // S-bit が無い旧 worktree は manifest 不在でも従来どおり許可する。
  let skipWorktreePaths: string[]
  try {
    skipWorktreePaths = listSkipWorktreePaths(worktreePath)
  } catch (error) {
    stopWithError(
      `Cannot safely inspect hidden tracked files: ${getErrorMessage(error)}`,
      EXIT_CODES.GENERAL_ERROR
    )
    return
  }
  const manifestPaths = new Set(Object.keys(managed).map(normalizeRel))
  const unmanagedSkipPaths = skipWorktreePaths
    .map(normalizeRel)
    .filter((relativePath) => !manifestPaths.has(relativePath))
  if (unmanagedSkipPaths.length > 0) {
    stopWithError(
      `Cannot safely remove worktree: tracked skip-worktree path(s) are missing from the wtb-managed manifest: ${unmanagedSkipPaths.join(", ")}. Inspect and preserve these files manually before repairing the manifest or clearing their skip-worktree flags.`,
      EXIT_CODES.GENERAL_ERROR
    )
    return
  }

  if (options.force) {
    out("⚠️  Force removal enabled")
  } else {
    // 破壊的処理 (volume 削除 / end_command) より前に dirty チェックで fail fast する。
    // 最後の `git worktree remove` は未コミット変更があると拒否するため、先に volume を
    // 消してから失敗すると「worktree は残るがデータ基盤だけ破壊済み」になってしまう。
    //
    // wtb は per-worktree compose / env を書き換えて skip-worktree を立てているので、
    // 素の `git status --porcelain` だけだと (1) skip-worktree により wtb の出力が
    // hidden になり、ユーザーが managed ファイルを手編集してもそれを見逃して worktree
    // ごと削除する (データ損失) / (2) 逆に解除すると wtb 自身の書き換えで常に dirty に
    // 見える、という両方の問題が起きる。
    //
    // そこで manifest (wtb が書いた直後の blob sha) を使う: managed ファイルの
    // skip-worktree を一旦解除して真の状態を status に surface させ、現在の blob sha が
    // manifest の sha と一致するもの (= wtb の出力そのまま) だけを dirty 判定から除外する。
    // ユーザーが手編集した managed ファイルや、その他の dirty ファイルは保護される。
    // manifest のキーは config 由来で "./.env" のような ./ prefix を含みうるが、git の
    // status / hash-object は正規化したパス (".env") を返す。両者を normalize して突き合わせる。
    for (const [relativePath, sha] of Object.entries(managed)) {
      if (!clearSkipWorktree(worktreePath, relativePath)) {
        restoreManagedSkipFlags()
        stopWithError(
          `Cannot safely inspect managed file '${relativePath}': failed to clear skip-worktree`,
          EXIT_CODES.GENERAL_ERROR
        )
        return
      }
      managedByNormalized.set(normalizeRel(relativePath), sha)
    }
    // managed な書き換えが 1 件でもあれば、それらは working tree 上 modified のままなので
    // 最終 `git worktree remove` を force する必要がある (このブロックを抜ける =
    // 真のユーザー変更は無いと確認済み)。
    if (managedByNormalized.size > 0) {
      forceGitRemoval = true
    }

    let reallyDirty: string[]
    try {
      reallyDirty = inspectWorktreeChanges()
    } catch (error) {
      restoreManagedSkipFlags()
      stopWithError(
        `Cannot safely inspect worktree changes: ${getErrorMessage(error)}`,
        EXIT_CODES.GENERAL_ERROR
      )
      return
    }

    if (reallyDirty.length > 0) {
      // 削除を拒否する = worktree は残る。上で skip-worktree を解除したままだと、wtb の
      // per-worktree 書き換えが git status に modified として残り続け、ユーザーが誤って
      // コミットしうる (skip-worktree が防ぐはずだった事故)。wtb 出力そのまま (sha 一致) の
      // managed ファイルは skip-worktree を復元する (ユーザー手編集分は可視のまま残す)。
      restoreManagedSkipFlags()
      stopWithError(
        `Worktree for '${branch}' has uncommitted or untracked changes; commit/stash them or pass -f to force removal`,
        EXIT_CODES.GENERAL_ERROR
      )
      return
    }
  }

  const skipDocker = options.docker === false
  const skipEnd = options.end === false
  const removeVolumes = options.removeVolumes === true

  const skippedOutcome = (reason: ComposeDownOutcome["skippedReason"]): ComposeDownOutcome => ({
    ran: false,
    failed: false,
    volumesRemoved: false,
    skippedReason: reason,
  })

  // Docker Compose teardown
  // - Only if compose file is actually configured (avoid path.resolve("") → worktree root bug)
  // - Skipped automatically when end_command is set (user owns teardown)
  if (config.docker_compose_file) {
    if (skipDocker) {
      composeDownOutcome = skippedOutcome("no-docker-flag")
      out("")
      out("⏭️  Skipping Docker Compose teardown (--no-docker)")
      // --remove-volumes は down -v 経由でしか作用しないので、teardown を飛ばすと
      // 黙って無視されてしまう。明示的な破壊フラグなので必ず警告する。
      if (removeVolumes) {
        out(
          "  ⚠️  --remove-volumes had no effect: Docker teardown was skipped (--no-docker). Remove the volumes manually with 'docker compose down -v' in the worktree."
        )
      }
    } else if (config.end_command) {
      composeDownOutcome = skippedOutcome("end-command")
      // end_command がある場合は teardown (= down -v) を行わないので、ここでも
      // --remove-volumes は作用しない。end_command 側で削除する必要がある旨を伝える。
      if (removeVolumes) {
        out("")
        out(
          "  ⚠️  --remove-volumes had no effect: end_command is set, so wtb skips the automatic 'docker compose down'. Make your end_command remove volumes (e.g. 'docker compose down -v'), or run it manually."
        )
      }
    } else {
      let worktreeComposePath: string | null = null
      let sourceComposePath: string | null = null
      try {
        worktreeComposePath = resolveRepositoryPath(worktreePath, config.docker_compose_file, {
          field: "docker_compose_file target",
          rejectSymlinkAncestors: true,
        })
        sourceComposePath = resolveRepositoryPath(gitRoot, config.docker_compose_file, {
          field: "docker_compose_file source",
          rejectSymlinkAncestors: true,
        })
      } catch (error) {
        const message = `Docker Compose teardown path is unsafe: ${getErrorMessage(error)}`
        composeDownOutcome = { ...skippedOutcome("unresolvable-project"), failed: true }
        cleanupErrors.push(message)
        out(`  ❌ ${message}`)
      }

      if (worktreeComposePath && sourceComposePath && existsSync(worktreeComposePath)) {
        // `docker compose down` は `-p` 無しだと env(COMPOSE_PROJECT_NAME) > 固定 name: >
        // ディレクトリ名 の順で project を解決する。worktree の .env や shell に
        // COMPOSE_PROJECT_NAME があると **source** プロジェクトに解決され、source の
        // コンテナ/ネットワーク (--remove-volumes なら volume まで) を消してしまう。
        // これを防ぐため target project 名を明示解決して `-p` で渡し、source と一致する
        // 場合は teardown を拒否する (create 側の self-overwrite ガードと対の防御)。
        const sourceComposeExists = existsSync(sourceComposePath)
        const sourceProject = sourceComposeExists
          ? safeResolveComposeProjectName(sourceComposePath, gitRoot)
          : undefined
        const targetProject = safeResolveComposeProjectName(worktreeComposePath, worktreePath)

        out("")
        if (sourceComposeExists && sourceProject === null) {
          const message =
            "Docker Compose teardown could not resolve the source project's identity; refusing to risk tearing down the wrong stack"
          composeDownOutcome = { ...skippedOutcome("unresolvable-project"), failed: true }
          cleanupErrors.push(message)
          out(`  ❌ ${message}`)
        } else if (targetProject === null) {
          const message =
            "Docker Compose teardown could not resolve this worktree's project name (compose unreadable)"
          composeDownOutcome = { ...skippedOutcome("unresolvable-project"), failed: true }
          cleanupErrors.push(message)
          out(`  ❌ ${message}`)
        } else if (sourceProject !== undefined && targetProject === sourceProject) {
          const message = `Docker Compose teardown refused: worktree and source resolve to the same project ('${targetProject}')`
          composeDownOutcome = { ...skippedOutcome("same-project"), failed: true }
          cleanupErrors.push(message)
          out(`  ❌ ${message}`)
        } else {
          try {
            assertComposeProjectUnique(
              worktrees,
              worktreePath,
              config.docker_compose_file,
              targetProject
            )
            assertDockerComposeProjectOwnedByWorktree(
              targetProject,
              worktreePath,
              config.docker_compose_file
            )
          } catch (error) {
            const message = `Docker Compose teardown refused: ${getErrorMessage(error)}`
            composeDownOutcome = { ...skippedOutcome("same-project"), failed: true }
            composeCleanupDockerFailure =
              error instanceof DockerComposeProjectInspectionError
            cleanupErrors.push(message)
            out(`  ❌ ${message}`)
          }

          if (!composeDownOutcome?.failed && removeVolumes) {
            try {
              assertComposeVolumesSafeForRemoval(
                worktreeComposePath,
                gitRoot,
                targetProject,
                branch,
                context.commonGitDir
              )
            } catch (error) {
              const message = `Docker volume removal safety check failed: ${getErrorMessage(error)}`
              composeDownOutcome = {
                ran: false,
                failed: true,
                volumesRemoved: false,
                skippedReason: "volume-ownership",
              }
              composeCleanupDockerFailure = error instanceof DockerVolumeInspectionError
              cleanupErrors.push(message)
              out(`  ❌ ${message}`)
            }
          }

          if (composeDownOutcome?.failed) {
            // Fail closed: do not call `docker compose down -v` after an ownership or
            // inspection failure. The common cleanup gate below keeps the worktree unless
            // --force was explicitly requested.
          } else {
            if (removeVolumes) {
              out("🐳 Stopping Docker Compose services and removing volumes...")
            } else {
              out("🐳 Stopping Docker Compose services...")
            }
            const downResult = await runDockerComposeDown(
              worktreePath,
              worktreeComposePath,
              targetProject,
              removeVolumes,
              gitRoot,
              branch,
              context.commonGitDir
            )
            composeDownOutcome = {
              ran: downResult.ran,
              failed: downResult.failed,
              volumesRemoved: removeVolumes && !downResult.failed,
              skippedReason:
                removeVolumes && !downResult.ran && downResult.failed
                  ? "volume-ownership"
                  : null,
            }
            composeCleanupDockerFailure = downResult.dockerFailure
            if (downResult.error) cleanupErrors.push(downResult.error)
          }
        }
      } else if (worktreeComposePath && sourceComposePath) {
        const message = `Docker Compose teardown cannot run: compose file is missing at ${config.docker_compose_file}`
        composeDownOutcome = { ...skippedOutcome("compose-file-missing"), failed: true }
        cleanupErrors.push(message)
        out(`  ❌ ${message}`)
        if (removeVolumes) {
          // compose file が worktree に無いと down -v を実行できない
          out("")
          out(
            `  ⚠️  --remove-volumes had no effect: no compose file at ${config.docker_compose_file} in the worktree to run 'docker compose down -v'.`
          )
        }
      }
    }
  } else if (removeVolumes) {
    // docker_compose_file 自体が未設定なら管理対象の volume は無い
    out("")
    out(
      "  ⚠️  --remove-volumes had no effect: no docker_compose_file is configured, so there are no wtb-managed volumes to remove."
    )
  }

  // end_commandの実行（worktree削除前）
  if (config.end_command) {
    if (skipEnd) {
      endCommandOutcome = { ran: false, failed: false }
      out("")
      out("⏭️  Skipping end command (--no-end)")
    } else {
      out("")
      out(`🛑 Running end command: ${config.end_command}`)
      const endFailed = await executeEndCommand(config.end_command, worktreePath)
      endCommandOutcome = {
        ran: true,
        failed: endFailed.failed,
        ...(endFailed.error && { error: endFailed.error }),
      }
      if (endFailed.error) cleanupErrors.push(endFailed.error)
    }
  }

  // cleanup 未達成なら通常は worktree を保持する。--force は削除を続行するが、後段で
  // 非ゼロ終了と ok:false を維持し、automation が部分失敗を見逃さないようにする。
  if (cleanupErrors.length > 0 && options.force !== true) {
    restoreManagedSkipFlags()
    const dockerFailure = composeCleanupDockerFailure
    stopWithError(
      `Cleanup failed; worktree was kept: ${cleanupErrors.join("; ")}`,
      dockerFailure ? EXIT_CODES.DOCKER_ERROR : EXIT_CODES.GENERAL_ERROR
    )
    return
  }

  // A non-explicit force is needed solely because wtb's own managed rewrites remain modified
  // after their skip-worktree flags were cleared. Cleanup may take arbitrarily long; a user or
  // editor can create/modify files after the initial dirty check. Calling `git worktree remove
  // --force` without a second check would then erase those late changes. Re-run the exact same
  // SHA/mode/status inspection immediately before the internal force. Explicit --force is the
  // user's intentional override and keeps its documented behavior.
  if (options.force !== true && forceGitRemoval) {
    let lateDirty: string[]
    try {
      // All managed S-bits were cleared before the first inspection. Any hidden flag now present
      // is a concurrent index change; even a manifest-listed S would hide bytes from status.
      const hiddenPaths = listSkipWorktreePaths(worktreePath)
      if (hiddenPaths.length > 0) {
        throw new Error(
          `skip-worktree was set during cleanup for: ${hiddenPaths.map(normalizeRel).join(", ")}`
        )
      }
      lateDirty = inspectWorktreeChanges()
    } catch (error) {
      restoreManagedSkipFlags()
      stopWithError(
        `Cannot safely revalidate worktree immediately before removal; cleanup may already have completed and the worktree was kept: ${getErrorMessage(error)}`,
        EXIT_CODES.GENERAL_ERROR
      )
      return
    }
    if (lateDirty.length > 0) {
      restoreManagedSkipFlags()
      stopWithError(
        `Worktree for '${branch}' changed during cleanup; cleanup may already have completed, but the worktree was kept to preserve the new changes`,
        EXIT_CODES.GENERAL_ERROR
      )
      return
    }
  }

  // worktreeを削除。wtb-managed な書き換えが残っていると非 force では git が拒否する
  // ため、dirty チェックを通過した場合は forceGitRemoval で最終削除を force する。
  try {
    removeWorktree(worktreePath, { force: forceGitRemoval, cwd: gitRoot })
    removed = true
  } catch (error) {
    restoreManagedSkipFlags()
    const exitCode =
      composeCleanupDockerFailure
        ? EXIT_CODES.DOCKER_ERROR
        : EXIT_CODES.GENERAL_ERROR
    stopWithError(`Failed to remove worktree: ${getErrorMessage(error)}`, exitCode)
    return
  }

  out("")
  if (cleanupErrors.length === 0) {
    out("🎉 Worktree removed successfully!")
  } else {
    out("⚠️  Worktree was force-removed, but cleanup was incomplete")
  }

  // 残りのworktree一覧を表示
  out("")
  out("📋 Remaining worktrees:")
  try {
    const remaining = listWorktrees(gitRoot)
    if (remaining.length === 0) {
      out("  No worktrees found")
    } else {
      for (const wt of remaining) {
        const isMain = isSamePath(wt.path, gitRoot)
        out(`  ${wt.branch}${isMain ? " (main)" : ""}: ${wt.path}`)
      }
    }
  } catch (error) {
    // Removal is already complete. Keep the public result truthful and treat this as a
    // non-fatal presentation error rather than turning a successful removal into a failure.
    out(`  ⚠️  Could not list remaining worktrees: ${getErrorMessage(error)}`)
  }

  writeJsonResult()
  if (cleanupErrors.length > 0) {
    process.exitCode =
      composeCleanupDockerFailure
        ? EXIT_CODES.DOCKER_ERROR
        : EXIT_CODES.GENERAL_ERROR
  }
}

/**
 * worktreeディレクトリで docker compose down を実行
 * Docker が利用できない場合は警告のみ（削除処理は継続）
 *
 * docker_compose_file は compose.dev.yml のような非デフォルト名でも良いので、
 * compose のデフォルト探索に頼らず `-f <path>` で明示的に渡す (composeStop と同じ流儀)。
 * project 名も `-p` で明示し、source プロジェクトを誤って down しないようにする。
 *
 * @param worktreePath - worktree のパス
 * @param composeFilePath - worktree 内の Compose ファイルの絶対パス
 * @param projectName - この worktree の Compose プロジェクト名 (source とは別物であること)
 * @param removeVolumes - true なら `down -v` で named volume も削除
 * @returns 失敗したら true (警告のみで削除処理は継続する。--json の failed に反映)
 */
async function runDockerComposeDown(
  worktreePath: string,
  composeFilePath: string,
  projectName: string,
  removeVolumes: boolean = false,
  mainRoot?: string,
  branch?: string,
  commonGitDir?: string
): Promise<{ ran: boolean; failed: boolean; dockerFailure: boolean; error?: string }> {
  let ran = false
  let composeSucceeded = false
  let releaseRepositoryLock: Awaited<ReturnType<typeof acquireRepositoryLock>> | undefined
  let result: { ran: boolean; failed: boolean; dockerFailure: boolean; error?: string } = {
    ran: false,
    failed: true,
    dockerFailure: false,
    error: "Docker Compose cleanup did not complete",
  }
  try {
    if (removeVolumes && commonGitDir) {
      releaseRepositoryLock = await acquireRepositoryLock(commonGitDir)
    }
    // Re-read Compose and re-inspect every existing volume immediately before `down -v`.
    // This narrows the gap in which a path or label could be changed after the first check.
    const validatedCompose = removeVolumes
      ? (() => {
          if (!mainRoot || !branch || !commonGitDir) {
            throw new Error("Repository identity is required to remove Docker volumes safely")
          }
          return assertComposeVolumesSafeForRemoval(
            composeFilePath,
            mainRoot,
            projectName,
            branch,
            commonGitDir
          )
        })()
      : (() => {
          const compose = readComposeFile(composeFilePath)
          assertComposeStorageDefinitionsSafe(compose)
          return compose
        })()
    withComposeSnapshot(composeFilePath, validatedCompose, (snapshotPath) => {
      ran = true
      composeDown(snapshotPath, projectName, worktreePath, removeVolumes)
      composeSucceeded = true
    })
    out(
      removeVolumes
        ? "  ✅ Docker Compose services stopped and volumes removed"
        : "  ✅ Docker Compose services stopped"
    )
    result = { ran: true, failed: false, dockerFailure: false }
  } catch (error) {
    const message = composeSucceeded
      ? `Docker Compose snapshot cleanup failed: ${getErrorMessage(error)}`
      : ran
        ? `Docker Compose down failed: ${getErrorMessage(error)}`
        : `Docker volume removal safety check failed: ${getErrorMessage(error)}`
    out(`  ❌ ${message}`)
    result = {
      ran,
      failed: true,
      dockerFailure:
        (ran && !composeSucceeded) || error instanceof DockerVolumeInspectionError,
      error: message,
    }
  } finally {
    if (releaseRepositoryLock) {
      try {
        await releaseRepositoryLock()
      } catch (error) {
        const message = `Failed to release repository safety lock: ${getErrorMessage(error)}`
        out(`  ❌ ${message}`)
        result = {
          ran,
          failed: true,
          dockerFailure: result?.dockerFailure ?? false,
          error: result?.error ? `${result.error}; ${message}` : message,
        }
      }
    }
  }
  return result
}

/** POSIX シェル向けに単一引用符でクオートする。 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * end_commandを実行
 * @returns 失敗したら true (従来通り警告のみで削除処理は継続する。--json の failed に反映)
 */
async function executeEndCommand(
  command: string,
  worktreePath: string
): Promise<{ failed: boolean; error?: string }> {
  try {
    const commandPath = path.resolve(worktreePath, command)
    // 昇格したパスは /bin/sh のコマンド文字列に埋まるのでクオートする (スペース等対策)。
    const actualCommand = existsSync(commandPath) ? shellQuote(commandPath) : command

    executeLifecycleCommand(actualCommand, worktreePath)
    out("  ✅ End command completed successfully")
    return { failed: false }
  } catch (error) {
    const message = `End command failed: ${getErrorMessage(error)}`
    out(`  ❌ ${message}`)
    return { failed: true, error: message }
  }
}
