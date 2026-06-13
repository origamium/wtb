/**
 * @fileoverview create コマンドの Docker Compose identity-rewrite + 単一 write の
 * ユニットテスト。
 *
 * setupDockerCompose が source compose を 1 度だけ読み、identity 書き換え → ポート調整を
 * in-memory に重ねてから worktree へ 1 度だけ書き出すこと、--json に composeIdentity が
 * 載ることを検証する。重い volume/env phase は config を絞って回避する。
 */

import type { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as loaderModule from "../../core/config/loader.js"
import * as clientModule from "../../core/docker/client.js"
import * as composeModule from "../../core/docker/compose.js"
import * as volumeModule from "../../core/docker/volume.js"
import * as repositoryModule from "../../core/git/repository.js"
import * as worktreeModule from "../../core/git/worktree.js"
import type { ComposeConfig, WtbConfig } from "../../types/index.js"
import { createCommand } from "./create.js"

vi.mock("../../core/config/loader.js")
vi.mock("../../core/git/repository.js")
vi.mock("../../core/git/worktree.js")
vi.mock("../../core/docker/client.js")
// Partial-mock compose: keep the real pure functions (sanitizeProjectSlug,
// rewriteComposeIdentity, adjustPortsInCompose, parsePortMapping) but stub the
// filesystem-touching read/write so we can inspect what gets written.
vi.mock("../../core/docker/compose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof composeModule>()
  return {
    ...actual,
    readComposeFile: vi.fn(),
    writeComposeFile: vi.fn(),
  }
})
vi.mock("../../core/docker/volume.js")
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    // source compose exists; target compose does NOT (so we write it); skill dir absent
    existsSync: vi.fn((p: string) => {
      const s = String(p)
      if (s.includes("worktree")) return false // target compose + .claude skill
      return true // source compose present
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
    vi.mocked(repositoryModule.branchExists).mockReturnValue(false)
    vi.mocked(repositoryModule.remoteBranchExists).mockReturnValue(false)
    vi.mocked(repositoryModule.revisionExists).mockReturnValue(true)
    vi.mocked(worktreeModule.getWorktreePath).mockReturnValue(null)
    vi.mocked(worktreeModule.listWorktrees).mockReturnValue([])
    vi.mocked(worktreeModule.createWorktree).mockReturnValue(undefined as never)
    vi.mocked(clientModule.getUsedPorts).mockReturnValue([])
    vi.mocked(loaderModule.loadConfig).mockReturnValue(config())

    // No volumes → volume phase is a silent no-op.
    vi.mocked(volumeModule.discoverCloneableVolumes).mockReturnValue([])

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
    vi.mocked(clientModule.getUsedPorts).mockReturnValue([3000]) // force a port bump
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
    vi.mocked(clientModule.getUsedPorts).mockReturnValue([3000])
    vi.mocked(loaderModule.loadConfig).mockReturnValue(
      config({ compose: { isolate_name: false, container_name: "keep" } })
    )
    await command.parseAsync(["feat", "--json", "--no-volume-copy"], { from: "user" })
    expect(composeModule.writeComposeFile).toHaveBeenCalledTimes(1)
    expect(worktreeModule.markWtbManagedFile).toHaveBeenCalledWith(
      expect.stringContaining("worktree-feat"),
      "./docker-compose.yml"
    )
  })
})
