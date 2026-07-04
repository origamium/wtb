/**
 * @fileoverview Remove コマンド実装
 * Git worktreeの削除を担当
 */

import { existsSync } from "node:fs"
import * as path from "node:path"
import { Command } from "commander"
import { EXIT_CODES } from "../../constants/index.js"
import { loadConfig } from "../../core/config/loader.js"
import { readComposeFile, resolveComposeProjectName } from "../../core/docker/compose.js"
import { getGitRootOrThrow } from "../../core/git/repository.js"
import {
  clearSkipWorktree,
  getWorktreePath,
  gitHashObject,
  isSamePath,
  listWorktrees,
  loadWtbManagedManifest,
  markSkipWorktreeIfTracked,
  removeWorktree,
} from "../../core/git/worktree.js"
import { CLIError, getErrorMessage } from "../../utils/error.js"
import { execDockerSafe, execGitSafe, executeLifecycleCommand } from "../../utils/exec.js"
import { withErrorHandling } from "../utils/command-helpers.js"

interface RemoveOptions {
  force?: boolean
  docker?: boolean
  end?: boolean
  removeVolumes?: boolean
}

/**
 * removeコマンドを作成
 */
export function removeCommand(): Command {
  return new Command("remove")
    .description("Remove a git worktree for the specified branch")
    .argument("<branch>", "Branch name of the worktree to remove")
    .option("-f, --force", "Force removal even if worktree has uncommitted changes")
    .option("--no-docker", "Skip Docker Compose teardown")
    .option("--no-end", "Skip end_command execution")
    .option(
      "--remove-volumes",
      "Also delete this worktree's Docker volumes (docker compose down -v). No effect when teardown is skipped (--no-docker, or end_command is set — your end_command must drop volumes itself)"
    )
    .action(withErrorHandling(executeRemoveCommand))
}

/**
 * removeコマンドのメイン実行ロジック
 */
async function executeRemoveCommand(branch: string, options: RemoveOptions): Promise<void> {
  const gitRoot = getGitRootOrThrow()

  // worktreeのパスを取得
  const worktreePath = getWorktreePath(branch)
  if (!worktreePath) {
    // 一覧はエラー診断の一部なので stderr に出す (stdout を script 出力用に汚さない)。
    // "Error: ..." 本文は withErrorHandling が CLIError から stderr へ出力する。
    console.error("Available worktrees:")
    const worktrees = listWorktrees()
    for (const wt of worktrees) {
      console.error(`  ${wt.branch}: ${wt.path}`)
    }
    throw new CLIError(`No worktree found for branch '${branch}'`, EXIT_CODES.GENERAL_ERROR)
  }

  // メインリポジトリの削除を防止。
  // git が片方を symlink 解決済み・片方を未解決で返すケースに備え、canonical path で比較する
  // （文字列等価だと symlink 経由でガードを回避でき、main repo を誤削除する恐れがある）。
  if (isSamePath(worktreePath, gitRoot)) {
    throw new CLIError("Cannot remove the main repository worktree", EXIT_CODES.GENERAL_ERROR)
  }

  console.log(`🗑️  Removing worktree for branch: ${branch}`)
  console.log(`📂 Worktree path: ${worktreePath}`)

  // wtb-managed ファイルの per-worktree 書き換えは (skip-worktree を解除すると)
  // `git worktree remove` を modified ファイル扱いで拒否させる。dirty チェックで
  // 「真のユーザー変更は無い」と確認できた場合に限り、最終的な git 削除を force する。
  // (ユーザー編集や未追跡ファイルがあれば下のチェックが先に throw する。)
  let forceGitRemoval = options.force === true

  if (options.force) {
    console.log("⚠️  Force removal enabled")
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
    const managed = loadWtbManagedManifest(worktreePath)
    // manifest のキーは config 由来で "./.env" のような ./ prefix を含みうるが、git の
    // status / hash-object は正規化したパス (".env") を返す。両者を normalize して突き合わせる。
    const normalizeRel = (p: string): string => {
      const n = path.normalize(p)
      return n.startsWith(`.${path.sep}`) ? n.slice(2) : n
    }
    const managedByNormalized = new Map<string, string>()
    for (const [relativePath, sha] of Object.entries(managed)) {
      clearSkipWorktree(worktreePath, relativePath)
      managedByNormalized.set(normalizeRel(relativePath), sha)
    }
    // managed な書き換えが 1 件でもあれば、それらは working tree 上 modified のままなので
    // 最終 `git worktree remove` を force する必要がある (このブロックを抜ける =
    // 真のユーザー変更は無いと確認済み)。
    if (managedByNormalized.size > 0) {
      forceGitRemoval = true
    }

    // core.quotePath=false: 非 ASCII のパス (例 `.env.日本語`) を git が 8 進エスケープ +
    // ダブルクオートで返すと managed 一致が外れ、sha が一致していても常に dirty 判定になり
    // remove が永久にブロックされる。クオートを無効化してパスをそのまま比較できるようにする。
    const status = execGitSafe(["-c", "core.quotePath=false", "status", "--porcelain"], {
      cwd: worktreePath,
    })
    const reallyDirty = status
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((line) => {
        // porcelain v1: 先頭 2 文字が status (XY)、その後にパス。staged/unstaged で
        // 区切り空白の数が揺れる (例 "M .env" vs " M docker-compose.yml") ので、固定
        // オフセットではなく「先頭 2 文字を落として残りを trim」でパスを取り出す。
        // rename ("R  a -> b") 等の複雑系はパスに " -> " が残り、下の managed 一致が
        // 外れるため保守的に dirty 判定になる。
        const filePath = normalizeRel(line.slice(2).trim())
        const recordedSha = managedByNormalized.get(filePath)
        if (recordedSha === undefined) return true // managed でなければ常に dirty
        const currentSha = gitHashObject(worktreePath, filePath)
        // wtb の出力そのまま (sha 一致) なら user 編集ではない → dirty に数えない。
        return currentSha === null || currentSha !== recordedSha
      })

    if (reallyDirty.length > 0) {
      // 削除を拒否する = worktree は残る。上で skip-worktree を解除したままだと、wtb の
      // per-worktree 書き換えが git status に modified として残り続け、ユーザーが誤って
      // コミットしうる (skip-worktree が防ぐはずだった事故)。wtb 出力そのまま (sha 一致) の
      // managed ファイルは skip-worktree を復元する (ユーザー手編集分は可視のまま残す)。
      for (const [normalized, sha] of managedByNormalized) {
        if (gitHashObject(worktreePath, normalized) === sha) {
          markSkipWorktreeIfTracked(normalized, worktreePath)
        }
      }
      throw new CLIError(
        `Worktree for '${branch}' has uncommitted or untracked changes; commit/stash them or pass -f to force removal`,
        EXIT_CODES.GENERAL_ERROR
      )
    }
  }

  const config = loadConfig(gitRoot)

  const skipDocker = options.docker === false
  const skipEnd = options.end === false
  const removeVolumes = options.removeVolumes === true

  // Docker Compose teardown
  // - Only if compose file is actually configured (avoid path.resolve("") → worktree root bug)
  // - Skipped automatically when end_command is set (user owns teardown)
  if (config.docker_compose_file) {
    if (skipDocker) {
      console.log("")
      console.log("⏭️  Skipping Docker Compose teardown (--no-docker)")
      // --remove-volumes は down -v 経由でしか作用しないので、teardown を飛ばすと
      // 黙って無視されてしまう。明示的な破壊フラグなので必ず警告する。
      if (removeVolumes) {
        console.log(
          "  ⚠️  --remove-volumes had no effect: Docker teardown was skipped (--no-docker). Remove the volumes manually with 'docker compose down -v' in the worktree."
        )
      }
    } else if (config.end_command) {
      // end_command がある場合は teardown (= down -v) を行わないので、ここでも
      // --remove-volumes は作用しない。end_command 側で削除する必要がある旨を伝える。
      if (removeVolumes) {
        console.log("")
        console.log(
          "  ⚠️  --remove-volumes had no effect: end_command is set, so wtb skips the automatic 'docker compose down'. Make your end_command remove volumes (e.g. 'docker compose down -v'), or run it manually."
        )
      }
    } else {
      const worktreeComposePath = path.resolve(worktreePath, config.docker_compose_file)
      if (existsSync(worktreeComposePath)) {
        // `docker compose down` は `-p` 無しだと env(COMPOSE_PROJECT_NAME) > 固定 name: >
        // ディレクトリ名 の順で project を解決する。worktree の .env や shell に
        // COMPOSE_PROJECT_NAME があると **source** プロジェクトに解決され、source の
        // コンテナ/ネットワーク (--remove-volumes なら volume まで) を消してしまう。
        // これを防ぐため target project 名を明示解決して `-p` で渡し、source と一致する
        // 場合は teardown を拒否する (create 側の self-overwrite ガードと対の防御)。
        const sourceComposePath = path.resolve(gitRoot, config.docker_compose_file)
        const sourceProject = safeResolveProject(sourceComposePath, gitRoot)
        const targetProject = safeResolveProject(worktreeComposePath, worktreePath)

        console.log("")
        if (targetProject === null) {
          console.log(
            "  ⚠️  Skipped Docker Compose teardown: could not resolve this worktree's Compose project name (compose unreadable). Tear it down manually if needed."
          )
        } else if (sourceProject !== null && targetProject === sourceProject) {
          console.log(
            `  ⚠️  Skipped Docker Compose teardown: this worktree resolves to the SAME Compose project as the source ('${targetProject}'), so 'docker compose down' would tear down your source stack${removeVolumes ? " and DELETE its volumes" : ""}. This usually means COMPOSE_PROJECT_NAME is set or the compose 'name:' is fixed. Tear it down manually if that's intended.`
          )
        } else {
          if (removeVolumes) {
            console.log("🐳 Stopping Docker Compose services and removing volumes...")
          } else {
            console.log("🐳 Stopping Docker Compose services...")
          }
          await runDockerComposeDown(
            worktreePath,
            worktreeComposePath,
            targetProject,
            removeVolumes
          )
        }
      } else if (removeVolumes) {
        // compose file が worktree に無いと down -v を実行できない
        console.log("")
        console.log(
          `  ⚠️  --remove-volumes had no effect: no compose file at ${config.docker_compose_file} in the worktree to run 'docker compose down -v'.`
        )
      }
    }
  } else if (removeVolumes) {
    // docker_compose_file 自体が未設定なら管理対象の volume は無い
    console.log("")
    console.log(
      "  ⚠️  --remove-volumes had no effect: no docker_compose_file is configured, so there are no wtb-managed volumes to remove."
    )
  }

  // end_commandの実行（worktree削除前）
  if (config.end_command) {
    if (skipEnd) {
      console.log("")
      console.log("⏭️  Skipping end command (--no-end)")
    } else {
      console.log("")
      console.log(`🛑 Running end command: ${config.end_command}`)
      await executeEndCommand(config.end_command, worktreePath)
    }
  }

  // worktreeを削除。wtb-managed な書き換えが残っていると非 force では git が拒否する
  // ため、dirty チェックを通過した場合は forceGitRemoval で最終削除を force する。
  removeWorktree(worktreePath, { force: forceGitRemoval })

  // 成功メッセージ
  console.log("")
  console.log("🎉 Worktree removed successfully!")

  // 残りのworktree一覧を表示
  console.log("")
  console.log("📋 Remaining worktrees:")
  const worktrees = listWorktrees()
  if (worktrees.length === 0) {
    console.log("  No worktrees found")
  } else {
    for (const wt of worktrees) {
      const isMain = wt.path === gitRoot
      console.log(`  ${wt.branch}${isMain ? " (main)" : ""}: ${wt.path}`)
    }
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
 */
async function runDockerComposeDown(
  worktreePath: string,
  composeFilePath: string,
  projectName: string,
  removeVolumes: boolean = false
): Promise<void> {
  try {
    const args = ["compose", "-f", composeFilePath, "-p", projectName, "down"]
    if (removeVolumes) {
      args.push("-v")
    }
    execDockerSafe(args, { cwd: worktreePath })
    console.log(
      removeVolumes
        ? "  ✅ Docker Compose services stopped and volumes removed"
        : "  ✅ Docker Compose services stopped"
    )
  } catch (error) {
    console.log(`  ⚠️  Docker Compose down skipped: ${getErrorMessage(error)}`)
    console.log("  (Continuing with worktree removal)")
  }
}

/** compose ファイルを読んで Compose プロジェクト名を解決する。読めなければ null。 */
function safeResolveProject(composePath: string, workdir: string): string | null {
  try {
    return resolveComposeProjectName(readComposeFile(composePath), workdir)
  } catch {
    return null
  }
}

/** POSIX シェル向けに単一引用符でクオートする。 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * end_commandを実行
 */
async function executeEndCommand(command: string, worktreePath: string): Promise<void> {
  try {
    const commandPath = path.resolve(worktreePath, command)
    // 昇格したパスは /bin/sh のコマンド文字列に埋まるのでクオートする (スペース等対策)。
    const actualCommand = existsSync(commandPath) ? shellQuote(commandPath) : command

    executeLifecycleCommand(actualCommand, worktreePath)
    console.log("  ✅ End command completed successfully")
  } catch (error) {
    console.log(`  ⚠️  End command failed: ${getErrorMessage(error)}`)
    console.log("  (Continuing with worktree removal)")
  }
}
