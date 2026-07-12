/**
 * @fileoverview create コマンドの Docker Compose identity-rewrite + 単一 write の
 * ユニットテスト。
 *
 * setupDockerCompose が source compose を 1 度だけ読み、identity 書き換え → ポート調整を
 * in-memory に重ねてから worktree へ 1 度だけ書き出すこと、--json に composeIdentity が
 * 載ることを検証する。重い volume/env phase は config を絞って回避する。
 */

import * as nodeFs from "node:fs"
import type { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as loaderModule from "../../core/config/loader.js"
import * as clientModule from "../../core/docker/client.js"
import * as composeModule from "../../core/docker/compose.js"
import * as volumeModule from "../../core/docker/volume.js"
import * as repositoryModule from "../../core/git/repository.js"
import * as worktreeModule from "../../core/git/worktree.js"
import type { ComposeConfig, WtbConfig } from "../../types/index.js"
import * as execModule from "../../utils/exec.js"
import { createCommand } from "./create.js"

vi.mock("../../core/config/loader.js")
vi.mock("../../core/git/repository.js")
vi.mock("../../core/git/worktree.js")
vi.mock("../../core/docker/client.js")
vi.mock("../../core/docker/project-ownership.js")
// Partial-mock compose: keep the real pure functions (sanitizeProjectSlug,
// rewriteComposeIdentity, adjustPortsInCompose, parsePortMapping) but stub the
// filesystem-touching read/write so we can inspect what gets written.
vi.mock("../../core/docker/compose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof composeModule>()
  return {
    ...actual,
    readComposeFile: vi.fn(),
    loadComposeInterpolationEnvironment: vi.fn(() =>
      Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] =>
          typeof entry[1] === "string"
        )
      )
    ),
    resolveComposeProjectNameForWorktree: vi.fn((cfg: ComposeConfig, workdir: string) => {
      const explicit = (cfg as { name?: unknown }).name
      return typeof explicit === "string" && explicit.length > 0
        ? explicit
        : workdir.split("/").pop() || "project"
    }),
    safeResolveComposeProjectName: vi.fn(() => "source-project"),
    writeComposeFile: vi.fn(),
  }
})
vi.mock("../../core/docker/volume.js")
vi.mock("../../utils/exec.js")
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    // Tracked compose exists in the target checkout; the optional skill dir does not.
    existsSync: vi.fn((p: string) => {
      const s = String(p)
      if (s.includes(".claude/skills/wtb")) return false
      const base = s.split("/").pop()
      if (base === ".env") return false
      if (
        base === "compose.yaml" ||
        base === "compose.yml" ||
        base === "docker-compose.yaml" ||
        base?.includes("compose.override.")
      ) {
        return false
      }
      return true
    }),
    lstatSync: vi.fn(),
    readlinkSync: vi.fn(),
    statSync: vi.fn(),
    symlinkSync: vi.fn(),
  }
})
vi.mock("fs-extra", () => ({
  default: { ensureDir: vi.fn(async () => {}), copy: vi.fn(async () => {}) },
  ensureDir: vi.fn(async () => {}),
  copy: vi.fn(async () => {}),
}))

const config = (overrides: Partial<WtbConfig> = {}): WtbConfig =>
  ({
    base_branch: "main",
    docker_compose_file: "./docker-compose.yml",
    copy_files: [],
    link_files: [],
    env: { file: [], adjust: {} },
    volumes: { exclude: [] },
    compose: { isolate_name: true, container_name: "suffix" },
    ...overrides,
  }) as WtbConfig

describe("create command Docker Compose identity rewrite", () => {
  let command: Command
  let writeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    command = createCommand()

    vi.mocked(repositoryModule.getGitRootOrThrow).mockReturnValue("/repo")
    vi.mocked(repositoryModule.getRepositoryContext).mockReturnValue({
      currentRoot: "/repo",
      mainRoot: "/repo",
      commonGitDir: "/repo/.git",
    })
    vi.mocked(repositoryModule.branchExists).mockReturnValue(false)
    vi.mocked(repositoryModule.remoteBranchExists).mockReturnValue(false)
    vi.mocked(repositoryModule.revisionExists).mockReturnValue(true)
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue(null)
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/repo", branch: "main", head: "main-sha" },
    ])
    vi.mocked(worktreeModule.createWorktree).mockReturnValue(undefined as never)
    vi.mocked(clientModule.getUsedPortsOrThrow).mockReturnValue([])
    vi.mocked(loaderModule.loadConfig).mockReturnValue(config())

    // No volumes → volume phase is a silent no-op.
    vi.mocked(volumeModule.discoverCloneableVolumes).mockReturnValue([])
    vi.mocked(volumeModule.repoVolumeLabel).mockReturnValue("repo-hash")
    vi.mocked(volumeModule.resolveVolumeName).mockImplementation((cfg, key, project) => {
      const entry = cfg.volumes?.[key] as { name?: unknown; external?: unknown } | null | undefined
      return {
        name: typeof entry?.name === "string" ? entry.name : `${project}_${key}`,
        external: entry?.external === true,
      }
    })

    const sourceCompose: ComposeConfig = {
      name: "myapp",
      services: {
        web: { image: "nginx", container_name: "myapp-web", ports: ["3000:80"] },
        db: { image: "postgres", container_name: "myapp-db" },
      },
    } as ComposeConfig
    vi.mocked(composeModule.readComposeFile).mockReturnValue(sourceCompose)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const parsePayload = () => {
    const jsonCall = writeSpy.mock.calls.find((c) => {
      try {
        JSON.parse(c[0] as string)
        return true
      } catch {
        return false
      }
    })
    expect(jsonCall).toBeDefined()
    return JSON.parse(jsonCall?.[0] as string)
  }

  it("writes the identity-rewritten + port-adjusted compose ONCE", async () => {
    vi.mocked(clientModule.getUsedPortsOrThrow).mockReturnValue([3000]) // force a port bump
    await command.parseAsync(["feature/Cool_Thing", "--no-volume-copy"], { from: "user" })

    // Exactly one write of the final transformed config (no read-adjust-write churn).
    expect(composeModule.writeComposeFile).toHaveBeenCalledTimes(1)
    const [writtenPath, writtenConfig] = vi.mocked(composeModule.writeComposeFile).mock.calls[0]
    expect(String(writtenPath)).toContain("worktree")

    const cfg = writtenConfig as ComposeConfig
    const slug = "feature-cool_thing"
    // identity rewrite applied
    expect((cfg as { name?: string }).name).toBe(`myapp-${slug}`)
    expect(cfg.services.web.container_name).toBe(`myapp-web-${slug}`)
    expect(cfg.services.db.container_name).toBe(`myapp-db-${slug}`)
    // port adjust applied in the SAME written object
    expect(cfg.services.web.ports).toEqual(["3001:80"])
    expect(composeModule.readComposeFile).toHaveBeenCalledWith(
      "/worktree-feature-Cool_Thing/docker-compose.yml"
    )
  })

  it("uses the target branch Compose and only falls back to main when target is absent", async () => {
    const main: ComposeConfig = {
      name: "main-app",
      services: { web: { image: "main", ports: ["3000:80"] } },
    }
    const branch: ComposeConfig = {
      name: "branch-app",
      services: { web: { image: "branch", ports: ["4000:80"] } },
    }
    vi.mocked(composeModule.readComposeFile).mockImplementation((filePath) =>
      String(filePath).includes("worktree") ? branch : main
    )

    await command.parseAsync(["feat", "--no-volume-copy"], { from: "user" })
    let written = vi.mocked(composeModule.writeComposeFile).mock.calls[0][1] as ComposeConfig
    expect(written.services.web.image).toBe("branch")
    expect(written.name).toBe("branch-app-feat")

    vi.clearAllMocks()
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue(null)
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/repo", branch: "main", head: "main-sha" },
    ])
    vi.mocked(repositoryModule.getGitRootOrThrow).mockReturnValue("/repo")
    vi.mocked(repositoryModule.getRepositoryContext).mockReturnValue({
      currentRoot: "/repo",
      mainRoot: "/repo",
      commonGitDir: "/repo/.git",
    })
    vi.mocked(repositoryModule.branchExists).mockReturnValue(false)
    vi.mocked(repositoryModule.remoteBranchExists).mockReturnValue(false)
    vi.mocked(repositoryModule.revisionExists).mockReturnValue(true)
    vi.mocked(loaderModule.loadConfig).mockReturnValue(
      config({ compose: { isolate_name: true, container_name: "keep" } })
    )
    vi.mocked(clientModule.getUsedPortsOrThrow).mockReturnValue([])
    vi.mocked(volumeModule.discoverCloneableVolumes).mockReturnValue([])
    vi.mocked(nodeFs.existsSync).mockImplementation((filePath) => {
      const value = String(filePath)
      return !value.includes("worktree") && !value.includes(".claude/skills/wtb")
    })
    vi.mocked(composeModule.readComposeFile).mockReturnValue(main)

    await command.parseAsync(["fallback", "--no-volume-copy"], { from: "user" })
    expect(composeModule.readComposeFile).toHaveBeenCalledWith("/repo/docker-compose.yml")
    written = vi.mocked(composeModule.writeComposeFile).mock.calls[0][1] as ComposeConfig
    expect(written.services.web.image).toBe("main")
  })

  it("does not let copy_files overwrite the target branch Compose before transformation", async () => {
    vi.mocked(loaderModule.loadConfig).mockReturnValue(
      config({ copy_files: ["./docker-compose.yml"] })
    )

    await command.parseAsync(["feat", "--no-volume-copy"], { from: "user" })

    const fsExtra = await import("fs-extra")
    expect(vi.mocked(fsExtra.default.copy)).not.toHaveBeenCalled()
    expect(composeModule.readComposeFile).toHaveBeenCalledWith(
      "/worktree-feat/docker-compose.yml"
    )
  })

  it("does not let copy_files overwrite a checked-out branch Compose with --no-docker", async () => {
    vi.mocked(loaderModule.loadConfig).mockReturnValue(
      config({ copy_files: ["./docker-compose.yml"] })
    )

    await command.parseAsync(["feat", "--no-docker"], { from: "user" })

    const fsExtra = await import("fs-extra")
    expect(vi.mocked(fsExtra.default.copy)).not.toHaveBeenCalled()
    expect(composeModule.readComposeFile).not.toHaveBeenCalled()
  })

  it("--json surfaces composeIdentity (project + container renames)", async () => {
    await command.parseAsync(["feature/x", "--json", "--no-volume-copy"], { from: "user" })

    const payload = parsePayload()
    expect(payload.composeIdentity.projectName).toEqual({ from: "myapp", to: "myapp-feature-x" })
    expect(payload.composeIdentity.containerNames).toEqual(
      expect.arrayContaining([
        { service: "web", from: "myapp-web", to: "myapp-web-feature-x" },
        { service: "db", from: "myapp-db", to: "myapp-db-feature-x" },
      ])
    )
  })

  it("treats managed-manifest persistence failure as Compose setup failure", async () => {
    vi.mocked(worktreeModule.markWtbManagedFile).mockReturnValue(false)

    await command.parseAsync(["feat", "--json", "--no-volume-copy"], { from: "user" })

    const payload = parsePayload()
    expect(payload.composeFailed).toBe(true)
    expect(payload.ok).toBe(false)
    expect(payload.setupFailures).toEqual([
      expect.objectContaining({
        phase: "compose",
        message: expect.stringContaining("managed-file metadata"),
      }),
    ])
  })

  it("container_name: strip removes the keys; isolate_name still rewrites project", async () => {
    vi.mocked(loaderModule.loadConfig).mockReturnValue(
      config({ compose: { isolate_name: true, container_name: "strip" } })
    )
    await command.parseAsync(["feat", "--no-volume-copy"], { from: "user" })
    const [, writtenConfig] = vi.mocked(composeModule.writeComposeFile).mock.calls[0]
    const cfg = writtenConfig as ComposeConfig
    expect("container_name" in cfg.services.web).toBe(false)
    expect("container_name" in cfg.services.db).toBe(false)
    expect((cfg as { name?: string }).name).toBe("myapp-feat")
  })

  it("injects a top-level project name when the branch Compose omits name", async () => {
    vi.mocked(composeModule.readComposeFile).mockReturnValue({
      services: { web: { image: "nginx" } },
    })

    await command.parseAsync(["feat", "--no-volume-copy"], { from: "user" })

    const written = vi.mocked(composeModule.writeComposeFile).mock.calls[0][1] as ComposeConfig
    expect(written.name).toBe("repo-feat")
  })

  it("container_name: keep + isolate_name:false + no port bump → compose left untouched (M2)", async () => {
    // M2: identity 書き換え・伝播・ポート調整のいずれも変化を生まない場合は、追跡
    // ファイルを無意味に reformat / skip-worktree しない (checkout 済みのまま残す)。
    // ここでは getUsedPorts=[] なので 3000 もそのまま → 全 transform が no-op。
    vi.mocked(loaderModule.loadConfig).mockReturnValue(
      config({ compose: { isolate_name: false, container_name: "keep" } })
    )
    await command.parseAsync(["feat", "--json", "--no-volume-copy"], { from: "user" })
    // 変化が無いので書き込みも skip-worktree マークも一切行わない。
    expect(composeModule.writeComposeFile).not.toHaveBeenCalled()
    expect(worktreeModule.markWtbManagedFile).not.toHaveBeenCalled()
    const payload = parsePayload()
    expect(payload.composeIdentity).toEqual({ containerNames: [] })
  })

  it("port bump alone (no identity change) still writes the compose (M2 change-path)", async () => {
    // identity は変えないが、used ポートに 3000 を入れて port bump を発生させる →
    // changed=true なので書き込み + managed マークが走ること。
    vi.mocked(clientModule.getUsedPortsOrThrow).mockReturnValue([3000])
    vi.mocked(loaderModule.loadConfig).mockReturnValue(
      config({ compose: { isolate_name: false, container_name: "keep" } })
    )
    vi.mocked(composeModule.resolveComposeProjectNameForWorktree).mockImplementation(
      (_cfg, workdir) => (workdir === "/repo" ? "source-project" : "target-project")
    )
    await command.parseAsync(["feat", "--json", "--no-volume-copy"], { from: "user" })
    expect(composeModule.writeComposeFile).toHaveBeenCalledTimes(1)
    expect(worktreeModule.markWtbManagedFile).toHaveBeenCalledWith(
      expect.stringContaining("worktree-feat"),
      "./docker-compose.yml"
    )
  })

  it("collects long-form published port changes in the JSON contract", async () => {
    vi.mocked(clientModule.getUsedPortsOrThrow).mockReturnValue([3000])
    vi.mocked(composeModule.readComposeFile).mockReturnValue({
      services: {
        web: {
          image: "nginx",
          ports: [{ target: 80, published: 3000, protocol: "tcp", mode: "host" }],
        },
      },
    })
    vi.mocked(loaderModule.loadConfig).mockReturnValue(
      config({ compose: { isolate_name: false, container_name: "keep" } })
    )

    await command.parseAsync(["feat", "--json", "--no-volume-copy"], { from: "user" })

    const payload = parsePayload()
    expect(payload.composePorts.web).toEqual([{ from: 3000, to: 3001 }])
    const written = vi.mocked(composeModule.writeComposeFile).mock.calls[0][1] as ComposeConfig
    expect(written.services.web.ports?.[0]).toMatchObject({ published: 3001 })
  })

  it("adds repository/project/branch ownership labels to target Compose volumes", async () => {
    vi.mocked(composeModule.readComposeFile).mockReturnValue({
      name: "myapp",
      services: { db: { image: "postgres" } },
      volumes: {
        data: { driver: "local", labels: { existing: "kept", "wtb.temp": "true" } },
      },
    })

    await command.parseAsync(["feat", "--no-volume-copy"], { from: "user" })

    const written = vi.mocked(composeModule.writeComposeFile).mock.calls[0][1] as ComposeConfig
    expect(written.volumes?.data.labels).toEqual({
      existing: "kept",
      "wtb.managed": "true",
      "wtb.repo": "repo-hash",
      "wtb.project": "myapp-feat",
      "wtb.branch": "feat",
      "wtb.temp": "false",
    })
  })

  it("fails Compose setup when a non-external fixed volume name is shared with source", async () => {
    vi.mocked(composeModule.readComposeFile).mockReturnValue({
      name: "myapp",
      services: { db: { image: "postgres" } },
      volumes: { data: { name: "prod_db" } },
    })

    await command.parseAsync(["feat", "--json", "--no-volume-copy"], { from: "user" })

    const payload = parsePayload()
    expect(payload.composeFailed).toBe(true)
    expect(payload.setupFailures).toEqual([
      expect.objectContaining({
        phase: "compose",
        message: expect.stringContaining("Non-external volume"),
      }),
    ])
    expect(composeModule.writeComposeFile).not.toHaveBeenCalled()
  })

  it("fails Compose setup when actual source and target project identities are equal", async () => {
    vi.mocked(composeModule.resolveComposeProjectNameForWorktree).mockReturnValue("fixed-project")

    await command.parseAsync(["feat", "--json", "--no-volume-copy"], { from: "user" })

    const payload = parsePayload()
    expect(payload.composeFailed).toBe(true)
    expect(payload.setupFailures[0].message).toContain("same Compose project")
    expect(composeModule.writeComposeFile).not.toHaveBeenCalled()
  })

  it("fails Compose setup while COMPOSE_FILE can bypass the managed target file", async () => {
    const previous = process.env.COMPOSE_FILE
    process.env.COMPOSE_FILE = "/repo/unsafe-compose.yml"
    try {
      await command.parseAsync(["feat", "--json", "--no-volume-copy"], { from: "user" })
    } finally {
      if (previous === undefined) delete process.env.COMPOSE_FILE
      else process.env.COMPOSE_FILE = previous
    }

    const payload = parsePayload()
    expect(payload.composeFailed).toBe(true)
    expect(payload.setupFailures[0].message).toContain("COMPOSE_FILE must be unset")
    expect(composeModule.writeComposeFile).not.toHaveBeenCalled()
  })

  it("does not run start_command after Compose isolation fails", async () => {
    vi.mocked(composeModule.resolveComposeProjectNameForWorktree).mockReturnValue("fixed-project")
    vi.mocked(loaderModule.loadConfig).mockReturnValue(
      config({ start_command: "docker compose up -d" })
    )

    await command.parseAsync(["feat", "--json", "--no-volume-copy"], { from: "user" })

    expect(execModule.executeLifecycleCommand).not.toHaveBeenCalled()
    expect(parsePayload().startCommand).toEqual({ ran: false, failed: false })
  })

  it("does not run seed_command after Compose isolation fails", async () => {
    vi.mocked(composeModule.resolveComposeProjectNameForWorktree).mockReturnValue("fixed-project")
    vi.mocked(loaderModule.loadConfig).mockReturnValue(
      config({ volumes: { exclude: [], seed_command: "npm run db:seed" } })
    )

    await command.parseAsync(["feat", "--seed", "--json"], { from: "user" })

    expect(execModule.executeLifecycleCommand).not.toHaveBeenCalled()
    expect(parsePayload().seed).toEqual({ ran: false, failed: false })
  })

  it("reserves long-form ports declared by sibling worktrees", async () => {
    vi.mocked(clientModule.getUsedPortsOrThrow).mockReturnValue([])
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/sibling", branch: "other", head: "abc" },
    ])
    vi.mocked(composeModule.readComposeFile).mockImplementation((filePath) => {
      if (String(filePath).startsWith("/sibling")) {
        return {
          services: { sibling: { image: "x", ports: [{ target: 80, published: "3000" }] } },
        }
      }
      return { services: { web: { image: "nginx", ports: ["3000:80"] } } }
    })
    vi.mocked(loaderModule.loadConfig).mockReturnValue(
      config({ compose: { isolate_name: false, container_name: "keep" } })
    )

    await command.parseAsync(["feat", "--no-volume-copy"], { from: "user" })

    const written = vi.mocked(composeModule.writeComposeFile).mock.calls[0][1] as ComposeConfig
    expect(written.services.web.ports).toEqual(["3001:80"])
  })

  it("resolves sibling Compose published-port variables before reserving them", async () => {
    vi.mocked(clientModule.getUsedPortsOrThrow).mockReturnValue([])
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/sibling", branch: "other", head: "abc" },
    ])
    vi.mocked(composeModule.loadComposeInterpolationEnvironment).mockImplementation((workdir) =>
      workdir === "/sibling" ? { SIBLING_PORT: "3000" } : {}
    )
    vi.mocked(composeModule.readComposeFile).mockImplementation((filePath) => {
      if (String(filePath).startsWith("/sibling")) {
        return {
          services: {
            sibling: {
              image: "x",
              ports: [
                // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Compose interpolation
                "${SIBLING_PORT}:80",
                // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Compose interpolation
                { target: 81, published: "${SIBLING_LONG_PORT:-3001}" },
              ],
            },
          },
        }
      }
      return { services: { web: { image: "nginx", ports: ["3000:80"] } } }
    })
    vi.mocked(loaderModule.loadConfig).mockReturnValue(
      config({ compose: { isolate_name: false, container_name: "keep" } })
    )

    await command.parseAsync(["feat", "--no-volume-copy"], { from: "user" })

    const written = vi.mocked(composeModule.writeComposeFile).mock.calls[0][1] as ComposeConfig
    expect(written.services.web.ports).toEqual(["3002:80"])
  })

  it("fails closed when a sibling Compose published-port variable is unresolved", async () => {
    vi.mocked(clientModule.getUsedPortsOrThrow).mockReturnValue([])
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/sibling", branch: "other", head: "abc" },
    ])
    vi.mocked(composeModule.loadComposeInterpolationEnvironment).mockReturnValue({})
    vi.mocked(composeModule.readComposeFile).mockImplementation((filePath) => {
      if (String(filePath).startsWith("/sibling")) {
        return {
          services: {
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Compose interpolation
            sibling: { image: "x", ports: ["${MISSING_PORT}:80"] },
          },
        }
      }
      return { services: { web: { image: "nginx", ports: ["3000:80"] } } }
    })
    vi.mocked(loaderModule.loadConfig).mockReturnValue(
      config({ compose: { isolate_name: false, container_name: "keep" } })
    )

    await command.parseAsync(["feat", "--json", "--no-volume-copy"], { from: "user" })

    const payload = parsePayload()
    expect(payload.ok).toBe(false)
    expect(payload.setupFailures[0].message).toContain("unresolved published-port")
    expect(composeModule.writeComposeFile).not.toHaveBeenCalled()
  })

  it("fails closed when a sibling uses unenumerable host networking", async () => {
    vi.mocked(clientModule.getUsedPortsOrThrow).mockReturnValue([])
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([
      { path: "/sibling", branch: "other", head: "abc" },
    ])
    vi.mocked(composeModule.readComposeFile).mockImplementation((filePath) => {
      if (String(filePath).startsWith("/sibling")) {
        return { services: { sibling: { image: "x", network_mode: "host" } } }
      }
      return { services: { web: { image: "nginx", ports: ["3000:80"] } } }
    })
    vi.mocked(loaderModule.loadConfig).mockReturnValue(
      config({ compose: { isolate_name: false, container_name: "keep" } })
    )

    await command.parseAsync(["feat", "--json", "--no-volume-copy"], { from: "user" })

    const payload = parsePayload()
    expect(payload.ok).toBe(false)
    expect(payload.setupFailures[0].message).toContain("network_mode: host")
    expect(composeModule.writeComposeFile).not.toHaveBeenCalled()
  })
})
