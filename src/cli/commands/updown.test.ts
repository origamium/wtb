/**
 * @fileoverview up / down コマンドのユニットテスト
 *
 * docker を呼ぶこと自体が目的のコマンドなので、ガードを最優先で検証する:
 * - main repo 拒否 / same-project ガード / project 解決不能では docker を一切呼ばないこと
 * - worktree 内の compose を `-f`、target project を `-p` 相当で渡すこと
 * - --json の stdout が単一 JSON オブジェクトであること
 */

import { existsSync } from "node:fs"
import * as path from "node:path"
import type { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EXIT_CODES } from "../../constants/index.js"
import * as loaderModule from "../../core/config/loader.js"
import * as composeModule from "../../core/docker/compose.js"
import * as projectOwnershipModule from "../../core/docker/project-ownership.js"
import * as volumeModule from "../../core/docker/volume.js"
import * as volumeRemovalModule from "../../core/docker/volume-removal.js"
import * as repositoryModule from "../../core/git/repository.js"
import * as worktreeModule from "../../core/git/worktree.js"
import { downCommand, upCommand } from "./updown.js"

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}))
vi.mock("../../core/config/loader.js")
vi.mock("../../core/docker/compose.js")
vi.mock("../../core/docker/volume.js")
vi.mock("../../core/docker/project-ownership.js")
vi.mock("../../core/docker/volume-removal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/docker/volume-removal.js")>()
  return {
    ...actual,
    assertComposeVolumesSafeForRemoval: vi.fn(),
  }
})
vi.mock("../../core/git/repository.js")
vi.mock("../../core/git/worktree.js")

const WORKTREE_PATH = "/wt/worktree-feature"
const COMPOSE_PATH = path.resolve(WORKTREE_PATH, "compose.dev.yml")

const baseConfig = {
  base_branch: "main",
  docker_compose_file: "compose.dev.yml",
  copy_files: [],
  link_files: [],
  env: { file: [], adjust: {} },
  volumes: { exclude: [] },
}

describe("up / down commands", () => {
  let up: Command
  let down: Command
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    up = upCommand()
    down = downCommand()
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(repositoryModule.getRepositoryContext).mockReturnValue({
      currentRoot: "/repo",
      mainRoot: "/repo",
      commonGitDir: "/repo/.git",
    })
    vi.mocked(repositoryModule.acquireRepositoryLock).mockResolvedValue(
      vi.fn().mockResolvedValue(undefined)
    )
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue(WORKTREE_PATH)
    // canonical 比較はテストでは単純 resolve で代替 (fixture パスは実在しないため)。
    vi.mocked(worktreeModule.canonicalPath).mockImplementation((p) => path.resolve(p))
    vi.mocked(worktreeModule.isSamePath).mockImplementation(
      (a, b) => path.resolve(a) === path.resolve(b)
    )
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/repo", branch: "main", head: "a" },
      { path: WORKTREE_PATH, branch: "feature/x", head: "b" },
    ])
    vi.mocked(loaderModule.loadConfig).mockReturnValue(baseConfig)
    // source(/repo) と worktree で別プロジェクトに解決される (一致するとガードが発動)。
    vi.mocked(composeModule.safeResolveComposeProjectName).mockImplementation((_path, workdir) =>
      workdir === "/repo" ? "srcproj" : "wtproj"
    )
    vi.mocked(composeModule.readComposeFile).mockReturnValue({ services: {}, volumes: {} })
    vi.mocked(composeModule.withComposeSnapshot).mockImplementation(
      (sourcePath, _config, operation) => operation(sourcePath)
    )
    vi.mocked(volumeRemovalModule.assertComposeVolumesSafeForRemoval).mockReturnValue({
      services: {},
      volumes: {},
    })
    vi.mocked(volumeModule.readVolumeRecoveryRecords).mockReturnValue([])
    vi.mocked(volumeModule.repoVolumeLabel).mockReturnValue("repohash")
    vi.mocked(volumeModule.acquireTargetVolumeLifecycleLeases).mockReturnValue({
      release: vi.fn(),
    })
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })

  /** process.exit を throw 化して exit code を検証するヘルパー */
  const expectExit = async (command: Command, args: string[], code: number): Promise<void> => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })
    await expect(command.parseAsync(args, { from: "user" })).rejects.toThrow("exit")
    expect(exit).toHaveBeenCalledWith(code)
    exit.mockRestore()
  }

  it("up runs composeUp with the worktree compose file, target project, and worktree cwd", async () => {
    await up.parseAsync(["feature/x"], { from: "user" })

    expect(composeModule.composeUp).toHaveBeenCalledWith(COMPOSE_PATH, "wtproj", WORKTREE_PATH)
  })

  it("runs a branch-only target Compose when the main source file does not exist", async () => {
    vi.mocked(existsSync).mockImplementation((value) =>
      path.resolve(String(value)) !== path.resolve("/repo/compose.dev.yml")
    )

    await up.parseAsync(["feature/x"], { from: "user" })

    expect(composeModule.composeUp).toHaveBeenCalled()
  })

  it("refuses a transient shell project override even for branch-only Compose", async () => {
    const previous = process.env.COMPOSE_PROJECT_NAME
    process.env.COMPOSE_PROJECT_NAME = "production"
    vi.mocked(existsSync).mockImplementation((value) =>
      path.resolve(String(value)) !== path.resolve("/repo/compose.dev.yml")
    )
    // The compose module is mocked in this suite, so model the real helper's
    // fail-closed result under a shell override.
    vi.mocked(composeModule.safeResolveComposeProjectName).mockReturnValue(null)

    try {
      await expectExit(up, ["feature/x"], EXIT_CODES.GENERAL_ERROR)
      expect(composeModule.composeUp).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.COMPOSE_PROJECT_NAME
      else process.env.COMPOSE_PROJECT_NAME = previous
    }
  })

  it("executes Compose against the validated immutable snapshot path", async () => {
    vi.mocked(composeModule.withComposeSnapshot).mockImplementation(
      (_sourcePath, _config, operation) => operation("/wt/.validated-compose.yml")
    )

    await up.parseAsync(["feature/x"], { from: "user" })

    expect(composeModule.composeUp).toHaveBeenCalledWith(
      "/wt/.validated-compose.yml",
      "wtproj",
      WORKTREE_PATH
    )
  })

  it("down runs composeDown without volume removal by default", async () => {
    await down.parseAsync(["feature/x"], { from: "user" })

    expect(composeModule.composeDown).toHaveBeenCalledWith(
      COMPOSE_PATH,
      "wtproj",
      WORKTREE_PATH,
      false
    )
  })

  it("down --remove-volumes passes removeVolumes=true", async () => {
    await down.parseAsync(["feature/x", "--remove-volumes"], { from: "user" })

    expect(volumeRemovalModule.assertComposeVolumesSafeForRemoval).toHaveBeenCalledWith(
      COMPOSE_PATH,
      "/repo",
      "wtproj",
      "feature/x",
      "/repo/.git"
    )
    expect(composeModule.composeDown).toHaveBeenCalledWith(
      COMPOSE_PATH,
      "wtproj",
      WORKTREE_PATH,
      true
    )
  })

  it("down --remove-volumes refuses an unsafe volume before invoking Docker Compose", async () => {
    vi.mocked(volumeRemovalModule.assertComposeVolumesSafeForRemoval).mockImplementationOnce(() => {
      throw new Error("Volume 'prod_db' is unmanaged")
    })

    await expectExit(down, ["feature/x", "--remove-volumes"], EXIT_CODES.GENERAL_ERROR)

    expect(composeModule.composeDown).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("prod_db"))
  })

  it("down --remove-volumes refuses a target with unresolved recovery state", async () => {
    vi.mocked(volumeRemovalModule.assertComposeVolumesSafeForRemoval).mockReturnValueOnce({
      services: {},
      volumes: { data: null },
    })
    vi.mocked(volumeModule.resolveVolumeName).mockReturnValue({
      name: "wtproj_data",
      external: false,
    })
    vi.mocked(volumeModule.readVolumeRecoveryRecords).mockReturnValueOnce([
      {
        path: "/repo/.git/wtb/volume-recovery/recovery.json",
        record: {
          version: 1,
          id: "recovery",
          createdAt: new Date(0).toISOString(),
          sourceVolume: "src_data",
          targetVolume: "wtproj_data",
          tempVolume: "wtproj_data_tmp",
          sourceBytes: 1,
          stagedBytes: 1,
          ownership: { repo: "repohash", project: "wtproj", branch: "feature/x" },
        },
      },
    ])

    await expectExit(down, ["feature/x", "--remove-volumes"], EXIT_CODES.GENERAL_ERROR)

    expect(composeModule.composeDown).not.toHaveBeenCalled()
  })

  it("down --remove-volumes returns Docker exit 5 when ownership cannot be inspected", async () => {
    vi.mocked(volumeRemovalModule.assertComposeVolumesSafeForRemoval).mockImplementationOnce(() => {
      throw new volumeRemovalModule.DockerVolumeInspectionError("daemon unavailable")
    })

    await expectExit(down, ["feature/x", "--remove-volumes"], EXIT_CODES.DOCKER_ERROR)

    expect(composeModule.composeDown).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("daemon unavailable"))
  })

  it("up returns Docker exit 5 when existing project ownership cannot be queried", async () => {
    vi.mocked(
      projectOwnershipModule.assertDockerComposeProjectOwnedByWorktree
    ).mockImplementationOnce(() => {
      throw new projectOwnershipModule.DockerComposeProjectInspectionError(
        "daemon unavailable"
      )
    })

    await expectExit(up, ["feature/x"], EXIT_CODES.DOCKER_ERROR)
    expect(composeModule.composeUp).not.toHaveBeenCalled()
  })

  it("up refuses an unisolatable network mode before starting Compose", async () => {
    vi.mocked(composeModule.assertComposeNetworkingSafe).mockImplementationOnce(() => {
      throw new Error("network_mode: container:source-db cannot be isolated")
    })

    await expectExit(up, ["feature/x"], EXIT_CODES.GENERAL_ERROR)

    expect(composeModule.composeUp).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("network_mode: container:"))
  })

  it("refuses the main repository worktree without invoking docker", async () => {
    vi.mocked(worktreeModule.isSamePath).mockReturnValue(true)

    await expectExit(up, ["main"], EXIT_CODES.GENERAL_ERROR)

    expect(composeModule.composeUp).not.toHaveBeenCalled()
    expect(composeModule.composeDown).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("main repository"))
  })

  it("hard-fails (exit 1) when the worktree resolves to the source project, docker never invoked", async () => {
    // COMPOSE_PROJECT_NAME 相当: source と worktree が同一プロジェクトに解決される。
    vi.mocked(composeModule.safeResolveComposeProjectName).mockReturnValue("srcproj")

    await expectExit(down, ["feature/x", "--remove-volumes"], EXIT_CODES.GENERAL_ERROR)

    expect(composeModule.composeDown).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("SAME Compose project as the source")
    )
  })

  it("hard-fails (exit 1) when the target project cannot be resolved", async () => {
    vi.mocked(composeModule.safeResolveComposeProjectName).mockImplementation((_path, workdir) =>
      workdir === "/repo" ? "srcproj" : null
    )

    await expectExit(up, ["feature/x"], EXIT_CODES.GENERAL_ERROR)

    expect(composeModule.composeUp).not.toHaveBeenCalled()
  })

  it("prints the worktree listing to stderr for an unknown branch and exits 1", async () => {
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue(null)

    await expectExit(up, ["nope"], EXIT_CODES.GENERAL_ERROR)

    expect(errorSpy).toHaveBeenCalledWith("Available worktrees:")
    expect(errorSpy).toHaveBeenCalledWith(`  feature/x: ${WORKTREE_PATH}`)
    expect(logSpy).not.toHaveBeenCalled()
    expect(composeModule.composeUp).not.toHaveBeenCalled()
  })

  it("exits with CONFIG_ERROR (4) when docker_compose_file is not configured", async () => {
    vi.mocked(loaderModule.loadConfig).mockReturnValue({
      ...baseConfig,
      docker_compose_file: undefined,
    } as never)

    await expectExit(up, ["feature/x"], EXIT_CODES.CONFIG_ERROR)

    expect(composeModule.composeUp).not.toHaveBeenCalled()
  })

  it("exits 1 when the compose file is missing inside the worktree (no gitRoot fallback)", async () => {
    vi.mocked(existsSync).mockReturnValue(false)

    await expectExit(up, ["feature/x"], EXIT_CODES.GENERAL_ERROR)

    expect(composeModule.composeUp).not.toHaveBeenCalled()
  })

  it("exits with DOCKER_ERROR (5) when docker compose fails", async () => {
    // Once: clearAllMocks は implementation を消さないため、後続テストへ漏らさない。
    vi.mocked(composeModule.composeUp).mockImplementationOnce(() => {
      throw new Error("docker daemon not running")
    })

    await expectExit(up, ["feature/x"], EXIT_CODES.DOCKER_ERROR)

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("docker compose up failed"))
  })

  it("--json writes exactly one JSON object to stdout and human lines to stderr", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await up.parseAsync(["feature/x", "--json"], { from: "user" })

    expect(writeSpy).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(String(writeSpy.mock.calls[0]?.[0]))
    expect(payload).toEqual({
      branch: "feature/x",
      path: WORKTREE_PATH,
      composeFile: COMPOSE_PATH,
      project: "wtproj",
      action: "up",
      ok: true,
    })
    // 人間向け進捗は stderr (out() の JSON モード) に出る。stdout は JSON のみ。
    expect(errorSpy).toHaveBeenCalled()
    expect(logSpy).not.toHaveBeenCalled()
    writeSpy.mockRestore()
  })

  it("down --json includes volumesRemoved", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await down.parseAsync(["feature/x", "--json", "--remove-volumes"], { from: "user" })

    const payload = JSON.parse(String(writeSpy.mock.calls[0]?.[0]))
    expect(payload).toMatchObject({ action: "down", ok: true, volumesRemoved: true })
    writeSpy.mockRestore()
  })

  it("resolves the worktree containing cwd when no branch is given", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(path.join(WORKTREE_PATH, "sub", "dir"))

    await up.parseAsync([], { from: "user" })

    expect(composeModule.composeUp).toHaveBeenCalledWith(COMPOSE_PATH, "wtproj", WORKTREE_PATH)
    cwdSpy.mockRestore()
  })

  it("works from inside a linked worktree: uses the MAIN root, not the current toplevel", async () => {
    // 回帰テスト: 旧実装は `git rev-parse --show-toplevel` (= worktree 内では worktree
    // 自身) を gitRoot に使っていたため、worktree 内からの実行が常に main-repo ガードで
    // 拒否されていた。getGitRootOrThrow が worktree 自身を返す状況でも、
    // getMainWorktreeRoot ("/repo") を使う現実装ではガードを通過して docker に到達する。
    vi.mocked(repositoryModule.getGitRootOrThrow).mockReturnValue(WORKTREE_PATH)
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(path.join(WORKTREE_PATH, "sub"))

    await up.parseAsync([], { from: "user" })

    expect(composeModule.composeUp).toHaveBeenCalledWith(COMPOSE_PATH, "wtproj", WORKTREE_PATH)
    cwdSpy.mockRestore()
  })

  it("picks the deepest matching worktree when one is nested under the main repo", async () => {
    // 先頭マッチだと main ("/repo") が常に勝って main-repo ガードが誤発動する。
    const nested = "/repo/wt/feature-nested"
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/repo", branch: "main", head: "a" },
      { path: nested, branch: "feature/nested", head: "c" },
    ])
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(path.join(nested, "src"))

    await up.parseAsync([], { from: "user" })

    expect(composeModule.composeUp).toHaveBeenCalledWith(
      path.resolve(nested, "compose.dev.yml"),
      "wtproj",
      nested
    )
    cwdSpy.mockRestore()
  })
})
