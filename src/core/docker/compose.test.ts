import * as os from "node:os"
import * as path from "node:path"
import fs from "fs-extra"
import { parse } from "yaml"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ComposeConfig } from "../../types/index.js"
import { buildPortMap } from "../environment/propagate.js"
import {
  adjustPortsInCompose,
  findAvailablePort,
  parsePortMapping,
  propagatePortsInComposeValues,
  readComposeFile,
  resolveComposeProjectName,
  rewriteComposeIdentity,
  sanitizeContainerName,
  sanitizeProjectSlug,
  uniqueProjectSlug,
  writeComposeFile,
} from "./compose"

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wtb-compose-test-"))
})

afterEach(() => {
  fs.removeSync(tmpDir)
})

const empty = (extra: Partial<ComposeConfig> = {}): ComposeConfig => ({
  services: {},
  ...extra,
})

describe("resolveComposeProjectName", () => {
  it("uses explicit `name:` from compose if set", () => {
    const config = empty({ name: "my_explicit" } as ComposeConfig)
    expect(resolveComposeProjectName(config, "/tmp/whatever")).toBe("my_explicit")
  })

  it("preserves underscores (compose-spec keeps [a-z0-9_-])", () => {
    expect(resolveComposeProjectName(empty(), "/tmp/my_proj")).toBe("my_proj")
  })

  it("preserves dashes", () => {
    expect(resolveComposeProjectName(empty(), "/tmp/my-proj")).toBe("my-proj")
  })

  it("strips dots (not replaces them)", () => {
    // matches `docker compose config` empirical output
    expect(resolveComposeProjectName(empty(), "/tmp/wtb-vc-real.hk4L")).toBe("wtb-vc-realhk4l")
  })

  it("strips spaces and other punctuation", () => {
    expect(resolveComposeProjectName(empty(), "/tmp/My Proj!")).toBe("myproj")
  })

  it("lowercases uppercase letters", () => {
    expect(resolveComposeProjectName(empty(), "/tmp/UPPER_DIR")).toBe("upper_dir")
  })

  it("falls back to wtb-project on empty basename", () => {
    expect(resolveComposeProjectName(empty(), "/")).toBe("wtb-project")
  })

  it("falls back to wtb-project when normalization yields empty string", () => {
    expect(resolveComposeProjectName(empty(), "/tmp/!!!")).toBe("wtb-project")
  })

  it("prepends 'wtb' when first char is not letter/digit (underscore)", () => {
    expect(resolveComposeProjectName(empty(), "/tmp/_leading")).toBe("wtb_leading")
  })

  it("prepends 'wtb' when first char is dash", () => {
    expect(resolveComposeProjectName(empty(), "/tmp/-leading")).toBe("wtb-leading")
  })

  it("ignores empty `name:` and falls through to dir basename", () => {
    const config = empty({ name: "" } as ComposeConfig)
    expect(resolveComposeProjectName(config, "/tmp/dir_name")).toBe("dir_name")
  })

  it("ignores non-string `name:` and falls through", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime guard
    const config = empty({ name: 42 as any })
    expect(resolveComposeProjectName(config, "/tmp/dir_name")).toBe("dir_name")
  })

  describe("COMPOSE_PROJECT_NAME env var", () => {
    it("uses COMPOSE_PROJECT_NAME when set and no `name:` field", () => {
      const env = { COMPOSE_PROJECT_NAME: "from_env" }
      expect(resolveComposeProjectName(empty(), "/tmp/dir_name", env)).toBe("from_env")
    })

    it("COMPOSE_PROJECT_NAME beats explicit `name:` field (verified vs `docker compose config`)", () => {
      // Docker Compose v2 precedence: -p > COMPOSE_PROJECT_NAME > name: > basename.
      // Ground-truthed empirically: `COMPOSE_PROJECT_NAME=from_env docker compose
      // config --format json | jq -r .name` returns "from_env" even with `name: from_yaml`.
      const config = empty({ name: "from_yaml" } as ComposeConfig)
      const env = { COMPOSE_PROJECT_NAME: "from_env" }
      expect(resolveComposeProjectName(config, "/tmp/dir_name", env)).toBe("from_env")
    })

    it("falls back to `name:` when COMPOSE_PROJECT_NAME is empty", () => {
      const config = empty({ name: "from_yaml" } as ComposeConfig)
      const env = { COMPOSE_PROJECT_NAME: "" }
      expect(resolveComposeProjectName(config, "/tmp/dir_name", env)).toBe("from_yaml")
    })

    it("ignores empty COMPOSE_PROJECT_NAME and falls back to dir basename", () => {
      const env = { COMPOSE_PROJECT_NAME: "" }
      expect(resolveComposeProjectName(empty(), "/tmp/dir_name", env)).toBe("dir_name")
    })

    it("ignores undefined COMPOSE_PROJECT_NAME and falls back to dir basename", () => {
      const env: NodeJS.ProcessEnv = {}
      expect(resolveComposeProjectName(empty(), "/tmp/dir_name", env)).toBe("dir_name")
    })
  })
})

describe("parsePortMapping", () => {
  it("parses HOST:CONTAINER", () => {
    expect(parsePortMapping("3000:80")).toEqual({ hostPort: 3000, containerPort: 80 })
  })

  it("parses IP:HOST:CONTAINER", () => {
    expect(parsePortMapping("0.0.0.0:3000:80")).toMatchObject({ hostPort: 3000, containerPort: 80 })
    expect(parsePortMapping("127.0.0.1:5432:5432")).toMatchObject({
      hostPort: 5432,
      containerPort: 5432,
    })
  })

  it("parses an optional /tcp or /udp protocol suffix", () => {
    expect(parsePortMapping("3000:80/tcp")).toMatchObject({ hostPort: 3000, containerPort: 80 })
    expect(parsePortMapping("6379:6379/udp")).toMatchObject({ hostPort: 6379, containerPort: 6379 })
  })

  it("returns null for non-string input", () => {
    // @ts-expect-error intentional misuse
    expect(parsePortMapping(3000)).toBeNull()
    // @ts-expect-error intentional misuse
    expect(parsePortMapping(undefined)).toBeNull()
  })

  it("returns null for malformed mappings", () => {
    expect(parsePortMapping("abc")).toBeNull()
    expect(parsePortMapping("3000")).toBeNull() // container-only / short syntax not handled
    expect(parsePortMapping("")).toBeNull()
  })

  it("returns null for documented-unsupported forms (ranges, IPv6) — left unmapped", () => {
    // These are valid Compose syntax but NOT in wtb's supported set; parsePortMapping
    // returns null so adjustPortsInCompose leaves them unchanged (no silent corruption).
    expect(parsePortMapping("5000-6000:5000-6000")).toBeNull()
    expect(parsePortMapping("[::1]:3000:80")).toBeNull()
  })
})

describe("findAvailablePort", () => {
  it("keeps the original port when it is free", () => {
    expect(findAvailablePort(3000, [])).toBe(3000)
    expect(findAvailablePort(5432, [5433, 5434])).toBe(5432)
  })

  it("keeps a free original host port even below the search floor (README: base kept if free)", () => {
    // A web service on host port 80 must NOT be force-moved to 3000 when 80 is free.
    expect(findAvailablePort(80, [])).toBe(80)
    expect(findAvailablePort(443, [3000, 3001])).toBe(443)
  })

  it("keeps a free original host port above the wtb search range", () => {
    expect(findAvailablePort(15432, [])).toBe(15432)
  })

  it("bumps to the next free port when the original is taken", () => {
    expect(findAvailablePort(3000, [3000])).toBe(3001)
    expect(findAvailablePort(3000, [3000, 3001, 3002])).toBe(3003)
  })

  it("biases a bump of a sub-floor occupied port into the wtb range", () => {
    // 80 is taken → search from the [3000, 9999] floor, not from 81 (avoid privileged ports).
    expect(findAvailablePort(80, [80])).toBe(3000)
  })

  it("does not return a port that is in use (regression: no in-use port on exhaustion)", () => {
    // Fill 3000..3099 (the old 100-attempt cap window); a correct search must look past it.
    const used = Array.from({ length: 100 }, (_, i) => 3000 + i)
    const got = findAvailablePort(3000, used)
    expect(used).not.toContain(got)
    expect(got).toBe(3100)
  })

  it("findAvailablePort(54321, [54321, 54322]) returns 54323 — not a 3000-range port (F3 regression)", () => {
    // Old code capped the search at PORT_RANGE.MAX (9999); the loop body never ran for
    // a 54321 base, so it fell back to returning the in-use basePort.
    expect(findAvailablePort(54321, [54321, 54322])).toBe(54323)
  })

  it("findAvailablePort(54321, [54321]) returns 54322 — first free above the high port", () => {
    expect(findAvailablePort(54321, [54321])).toBe(54322)
  })

  it("findAvailablePort(54321, []) returns 54321 — free port is kept as-is", () => {
    // Fast-path: original is free, return it unchanged.
    expect(findAvailablePort(54321, [])).toBe(54321)
  })
})

describe("adjustPortsInCompose", () => {
  const cfg = (ports: string[]): ComposeConfig => ({
    services: { web: { image: "x", ports } },
  })

  it("keeps free ports and does not mutate the input config", () => {
    const input = cfg(["3000:80"])
    const out = adjustPortsInCompose(input, [])
    expect(out.services.web.ports).toEqual(["3000:80"])
    expect(input.services.web.ports).toEqual(["3000:80"]) // structuredClone — original untouched
  })

  it("preserves the IP prefix and /proto suffix while bumping the host port", () => {
    const out = adjustPortsInCompose(cfg(["0.0.0.0:3000:80/tcp"]), [3000])
    expect(out.services.web.ports).toEqual(["0.0.0.0:3001:80/tcp"])
  })

  it("bumps only the host side when host == container", () => {
    const out = adjustPortsInCompose(cfg(["3000:3000"]), [3000])
    expect(out.services.web.ports).toEqual(["3001:3000"])
  })

  it("resolves collisions across services within a single pass", () => {
    const out = adjustPortsInCompose(
      {
        services: { a: { image: "x", ports: ["3000:80"] }, b: { image: "y", ports: ["3000:80"] } },
      },
      []
    )
    const all = [...out.services.a.ports, ...out.services.b.ports]
    expect(all).toEqual(["3000:80", "3001:80"])
  })

  it("leaves unparseable mappings (e.g. ranges) untouched rather than corrupting them", () => {
    const out = adjustPortsInCompose(cfg(["5000-6000:5000-6000"]), [5000])
    expect(out.services.web.ports).toEqual(["5000-6000:5000-6000"])
  })
})

describe("propagatePortsInComposeValues", () => {
  // KONG_HTTP_PORT bumped 54321 → 54322 by env.adjust.
  const envChanges = { KONG_HTTP_PORT: { from: "54321", to: "54322" } }
  const map = buildPortMap([{ key: "KONG_HTTP_PORT", from: "54321", to: "54322" }])

  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose ${VAR:-default} syntax
  it("rewrites both a bare-port URL in environment and the ${VAR:-default} in ports", () => {
    const cfg: ComposeConfig = {
      services: {
        kong: {
          image: "kong",
          environment: { API_EXTERNAL_URL: "http://127.0.0.1:54321" },
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose syntax
          ports: ["${KONG_HTTP_PORT:-54321}:8000"],
        },
      },
    }
    const { config, changes } = propagatePortsInComposeValues(cfg, envChanges, map)

    expect((config.services.kong.environment as Record<string, string>).API_EXTERNAL_URL).toBe(
      "http://127.0.0.1:54322"
    )
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose syntax
    expect(config.services.kong.ports).toEqual(["${KONG_HTTP_PORT:-54322}:8000"])
    // input untouched (structuredClone)
    expect((cfg.services.kong.environment as Record<string, string>).API_EXTERNAL_URL).toBe(
      "http://127.0.0.1:54321"
    )

    const locations = changes.map((c) => c.location).sort()
    expect(locations).toEqual(["kong.environment.API_EXTERNAL_URL", "kong.ports[0]"])
  })

  it("handles list-form environment (KEY=VALUE) keeping the KEY intact", () => {
    const cfg: ComposeConfig = {
      services: {
        kong: {
          image: "kong",
          environment: ["API_EXTERNAL_URL=http://127.0.0.1:54321", "FOO=bar"],
        },
      },
    }
    const { config } = propagatePortsInComposeValues(cfg, envChanges, map)
    expect(config.services.kong.environment).toEqual([
      "API_EXTERNAL_URL=http://127.0.0.1:54322",
      "FOO=bar",
    ])
  })

  it("does NOT touch a 5432 substring when only 54321 is mapped (boundary safety)", () => {
    const cfg: ComposeConfig = {
      services: {
        db: {
          image: "postgres",
          environment: { DATABASE_URL: "postgres://user@127.0.0.1:5432/db" },
        },
      },
    }
    const { config, changes } = propagatePortsInComposeValues(cfg, envChanges, map)
    expect((config.services.db.environment as Record<string, string>).DATABASE_URL).toBe(
      "postgres://user@127.0.0.1:5432/db"
    )
    expect(changes).toHaveLength(0)
  })

  it("with an empty port map leaves everything unchanged (propagation effectively off)", () => {
    const cfg: ComposeConfig = {
      services: {
        kong: {
          image: "kong",
          environment: { API_EXTERNAL_URL: "http://127.0.0.1:54321" },
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose syntax
          ports: ["${KONG_HTTP_PORT:-54321}:8000"],
        },
      },
    }
    const { config, changes } = propagatePortsInComposeValues(cfg, {}, new Map())
    expect((config.services.kong.environment as Record<string, string>).API_EXTERNAL_URL).toBe(
      "http://127.0.0.1:54321"
    )
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose syntax
    expect(config.services.kong.ports).toEqual(["${KONG_HTTP_PORT:-54321}:8000"])
    expect(changes).toHaveLength(0)
  })

  it("does NOT rewrite the container-side port of a parseable literal mapping (H1)", () => {
    // 5432:5432 は adjustPortsInCompose の管轄。伝播が :5432 (コンテナ側) を書き換えると
    // 公開ポートが listen ポートと食い違う。parseable なマッピングは伝播対象外にする。
    const envChanges = { DB_PORT: { from: "5432", to: "5433" } }
    const map = buildPortMap([{ key: "DB_PORT", from: "5432", to: "5433" }])
    const cfg: ComposeConfig = {
      services: { db: { image: "postgres", ports: ["5432:5432"] } },
    }
    const { config, changes } = propagatePortsInComposeValues(cfg, envChanges, map)
    expect(config.services.db.ports).toEqual(["5432:5432"])
    expect(changes).toHaveLength(0)
  })

  it("still rewrites a variable-default host port (propagation's real target)", () => {
    const envChanges = { DB_PORT: { from: "5432", to: "5433" } }
    const map = buildPortMap([{ key: "DB_PORT", from: "5432", to: "5433" }])
    const cfg: ComposeConfig = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose syntax
      services: { db: { image: "postgres", ports: ["${DB_PORT:-5432}:5432"] } },
    }
    const { config } = propagatePortsInComposeValues(cfg, envChanges, map)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose syntax
    expect(config.services.db.ports).toEqual(["${DB_PORT:-5433}:5432"])
  })

  it("does not double-hop a chained map when substituting a variable default (F6)", () => {
    // A:3001→3002, B:3002→3003。旧実装は defaults→ports の順で B の new(3002) を再マップして
    // 3003 にしてしまった。ports→defaults の順にして単一ホップに保つ。
    const envChanges = { A_URL: { from: "x:3001", to: "x:3002" } }
    const map = buildPortMap([
      { key: "A", from: "3001", to: "3002" },
      { key: "B", from: "3002", to: "3003" },
    ])
    const cfg: ComposeConfig = {
      services: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose syntax
        app: { image: "app", environment: { DB: "${A_URL:-host:3001}" } },
      },
    }
    const { config } = propagatePortsInComposeValues(cfg, envChanges, map)
    // rule-1 が A_URL の new 値 (x:3002) を差し込む。ports パスが 3002→3003 に再マップしない。
    expect((config.services.app.environment as Record<string, string>).DB).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose syntax
      "${A_URL:-x:3002}"
    )
  })
})

describe("readComposeFile — YAML merge keys (H7)", () => {
  it("resolves `<<: *anchor` so anchored ports/container_name become visible", () => {
    const yaml = [
      "services:",
      "  base: &base",
      "    image: postgres",
      '    ports: ["5432:5432"]',
      "  db:",
      "    <<: *base",
      "    container_name: mydb",
      "",
    ].join("\n")
    const filePath = path.join(tmpDir, "docker-compose.yml")
    fs.writeFileSync(filePath, yaml)
    const cfg = readComposeFile(filePath)
    // merge key を解決しないと db.ports は undefined になり全書き換えが素通りする。
    expect(cfg.services.db.ports).toEqual(["5432:5432"])
    expect((cfg.services.db as { container_name?: string }).container_name).toBe("mydb")
  })
})

describe("uniqueProjectSlug", () => {
  it("returns the plain slug when there is no collision", () => {
    expect(uniqueProjectSlug("feature/x", ["main", "other"])).toBe("feature-x")
  })

  it("ignores the branch itself in the collision set", () => {
    expect(uniqueProjectSlug("feature/x", ["feature/x", "main"])).toBe("feature-x")
  })

  it("disambiguates when two different branches collapse to the same slug", () => {
    // 機能-a と 修正-a は sanitizeProjectSlug では両方 'a' に畳まれる。
    const a = uniqueProjectSlug("機能-a", ["修正-a"])
    const b = uniqueProjectSlug("修正-a", ["機能-a"])
    expect(a).not.toBe(b)
    // ハッシュは決定的 (同じ入力なら同じ出力)。
    expect(uniqueProjectSlug("機能-a", ["修正-a"])).toBe(a)
  })
})

describe("sanitizeProjectSlug", () => {
  it("lowercases, replaces invalid chars with '-', and keeps underscores", () => {
    expect(sanitizeProjectSlug("feature/Foo_Bar!")).toBe("feature-foo_bar")
  })

  it("collapses repeated dashes", () => {
    expect(sanitizeProjectSlug("a//__b")).toBe("a-__b")
    expect(sanitizeProjectSlug("a   b")).toBe("a-b")
  })

  it("strips a leading underscore (not a valid compose-v2 first char)", () => {
    expect(sanitizeProjectSlug("_leading")).toBe("leading")
  })

  it("strips leading dashes produced by leading invalid chars", () => {
    expect(sanitizeProjectSlug("!!!abc")).toBe("abc")
  })

  it("keeps a leading digit (valid first char in compose v2)", () => {
    expect(sanitizeProjectSlug("1-branch")).toBe("1-branch")
  })

  it("trims trailing dashes", () => {
    expect(sanitizeProjectSlug("branch/")).toBe("branch")
  })

  it("falls back to 'wtb' when the input sanitizes to empty", () => {
    expect(sanitizeProjectSlug("///")).toBe("wtb")
    expect(sanitizeProjectSlug("")).toBe("wtb")
  })
})

describe("sanitizeContainerName", () => {
  it("preserves uppercase and dots (unlike project slug)", () => {
    expect(sanitizeContainerName("My.App-db")).toBe("My.App-db")
  })

  it("replaces invalid chars with '-'", () => {
    expect(sanitizeContainerName("api/server!")).toBe("api-server-")
  })

  it("strips leading invalid chars (., -) until a valid first char remains", () => {
    expect(sanitizeContainerName("-leading")).toBe("leading")
    expect(sanitizeContainerName(".dotfirst")).toBe("dotfirst")
  })

  it("falls back to 'wtb' when empty", () => {
    expect(sanitizeContainerName("")).toBe("wtb")
  })
})

describe("rewriteComposeIdentity", () => {
  const cfg = (extra: Partial<ComposeConfig> = {}): ComposeConfig => ({
    services: { web: { image: "nginx" }, db: { image: "postgres" } },
    ...extra,
  })

  it("rewrites top-level name when present and isolateName=true (re-sanitizing the join)", () => {
    const input = cfg({ name: "myapp" } as ComposeConfig)
    const { config, rewrite } = rewriteComposeIdentity(input, {
      slug: "feature-x",
      isolateName: true,
      containerNameMode: "keep",
    })
    expect((config as { name?: string }).name).toBe("myapp-feature-x")
    expect(rewrite.projectName).toEqual({ from: "myapp", to: "myapp-feature-x" })
    // original untouched (structuredClone)
    expect((input as { name?: string }).name).toBe("myapp")
  })

  it("leaves name absent when the source has no name:", () => {
    const { config, rewrite } = rewriteComposeIdentity(cfg(), {
      slug: "feature-x",
      isolateName: true,
      containerNameMode: "keep",
    })
    expect((config as { name?: string }).name).toBeUndefined()
    expect(rewrite.projectName).toBeUndefined()
  })

  it("leaves name untouched when isolateName=false", () => {
    const { config, rewrite } = rewriteComposeIdentity(cfg({ name: "myapp" } as ComposeConfig), {
      slug: "feature-x",
      isolateName: false,
      containerNameMode: "keep",
    })
    expect((config as { name?: string }).name).toBe("myapp")
    expect(rewrite.projectName).toBeUndefined()
  })

  it("suffix mode: appends the slug to each container_name", () => {
    const input = cfg({
      services: {
        web: { image: "nginx", container_name: "web" },
        db: { image: "postgres", container_name: "db" },
      },
    })
    const { config, rewrite } = rewriteComposeIdentity(input, {
      slug: "feat-1",
      isolateName: false,
      containerNameMode: "suffix",
    })
    expect(config.services.web.container_name).toBe("web-feat-1")
    expect(config.services.db.container_name).toBe("db-feat-1")
    expect(rewrite.containerNames).toEqual([
      { service: "web", from: "web", to: "web-feat-1" },
      { service: "db", from: "db", to: "db-feat-1" },
    ])
  })

  it("strip mode: removes the container_name key entirely", () => {
    const input = cfg({
      services: { web: { image: "nginx", container_name: "web" } },
    })
    const { config, rewrite } = rewriteComposeIdentity(input, {
      slug: "feat-1",
      isolateName: false,
      containerNameMode: "strip",
    })
    expect("container_name" in config.services.web).toBe(false)
    expect(rewrite.containerNames).toEqual([{ service: "web", from: "web", to: undefined }])
  })

  it("keep mode: leaves container_name untouched and records nothing", () => {
    const input = cfg({
      services: { web: { image: "nginx", container_name: "web" } },
    })
    const { config, rewrite } = rewriteComposeIdentity(input, {
      slug: "feat-1",
      isolateName: true,
      containerNameMode: "keep",
    })
    expect(config.services.web.container_name).toBe("web")
    expect(rewrite.containerNames).toEqual([])
  })

  it("ignores services without a container_name in suffix mode", () => {
    const { rewrite } = rewriteComposeIdentity(cfg(), {
      slug: "feat-1",
      isolateName: false,
      containerNameMode: "suffix",
    })
    expect(rewrite.containerNames).toEqual([])
  })

  it("Supabase-like fixture: fixed name + several container_name services", () => {
    const input: ComposeConfig = {
      name: "supabase",
      services: {
        db: { image: "supabase/postgres", container_name: "supabase-db" },
        auth: { image: "supabase/gotrue", container_name: "supabase-auth" },
        rest: { image: "postgrest/postgrest", container_name: "supabase-rest" },
        studio: { image: "supabase/studio" }, // no container_name
      },
    } as ComposeConfig
    const { config, rewrite } = rewriteComposeIdentity(input, {
      slug: "pr-42",
      isolateName: true,
      containerNameMode: "suffix",
    })
    expect((config as { name?: string }).name).toBe("supabase-pr-42")
    expect(config.services.db.container_name).toBe("supabase-db-pr-42")
    expect(config.services.auth.container_name).toBe("supabase-auth-pr-42")
    expect(config.services.rest.container_name).toBe("supabase-rest-pr-42")
    expect("container_name" in config.services.studio).toBe(false)
    expect(rewrite.projectName).toEqual({ from: "supabase", to: "supabase-pr-42" })
    expect(rewrite.containerNames).toHaveLength(3)
  })
})

// =============================================================================
// H1 — writeComposeFile YAML 1.1 type-coercion safety
// =============================================================================

describe("writeComposeFile — YAML 1.1 dangerous-value quoting (H1)", () => {
  function roundTrip(env: Record<string, string>): Record<string, string> {
    const config: ComposeConfig = {
      services: { svc: { image: "x", environment: env } },
    }
    const filePath = path.join(tmpDir, "docker-compose.yml")
    writeComposeFile(filePath, config)
    const raw = fs.readFileSync(filePath, "utf-8")
    // Parse under YAML 1.2 (what the yaml lib does) to confirm strings survive
    const parsed = parse(raw) as ComposeConfig
    return (parsed.services.svc.environment as Record<string, string>) ?? {}
  }

  it('TZ: "00:00" stays a string (not sexagesimal 0)', () => {
    const result = roundTrip({ TZ: "00:00" })
    expect(result.TZ).toBe("00:00")
    expect(typeof result.TZ).toBe("string")
  })

  it('ENABLE: "yes" stays a string (not boolean true)', () => {
    const result = roundTrip({ ENABLE: "yes" })
    expect(result.ENABLE).toBe("yes")
    expect(typeof result.ENABLE).toBe("string")
  })

  it('DISABLE: "no" stays a string (not boolean false)', () => {
    const result = roundTrip({ DISABLE: "no" })
    expect(result.DISABLE).toBe("no")
  })

  it('FLAG: "true" stays a string', () => {
    const result = roundTrip({ FLAG: "true" })
    expect(result.FLAG).toBe("true")
    expect(typeof result.FLAG).toBe("string")
  })

  it('NULL_VAL: "null" stays a string (not null)', () => {
    const result = roundTrip({ NULL_VAL: "null" })
    expect(result.NULL_VAL).toBe("null")
  })

  it('TILDE: "~" stays a string (not null)', () => {
    const result = roundTrip({ TILDE: "~" })
    expect(result.TILDE).toBe("~")
  })

  it('"5432" stays a string (pure number)', () => {
    const result = roundTrip({ DB_PORT: "5432" })
    expect(result.DB_PORT).toBe("5432")
    expect(typeof result.DB_PORT).toBe("string")
  })

  it('"on" stays a string (YAML 1.1 boolean)', () => {
    const result = roundTrip({ FEATURE: "on" })
    expect(result.FEATURE).toBe("on")
  })

  it("normal non-dangerous strings are NOT quoted (readability preserved)", () => {
    const filePath = path.join(tmpDir, "docker-compose.yml")
    const config: ComposeConfig = {
      services: { svc: { image: "x", environment: { HOST: "localhost", PATH_VAR: "/usr/bin" } } },
    }
    writeComposeFile(filePath, config)
    const raw = fs.readFileSync(filePath, "utf-8")
    // Normal strings should appear unquoted
    expect(raw).toContain("localhost")
    expect(raw).toContain("/usr/bin")
  })
})

// =============================================================================
// H3 — adjustPortsInCompose does NOT corrupt IP octets
// =============================================================================

describe("adjustPortsInCompose — IP prefix not corrupted when port digits appear in IP (H3)", () => {
  it("host port 100 with IP 192.168.100.100 is reconstructed correctly", () => {
    const cfg: ComposeConfig = {
      services: { db: { image: "postgres", ports: ["192.168.100.100:100:80"] } },
    }
    const out = adjustPortsInCompose(cfg, [100])
    // Old string-replace: "192.168.100.100:100:80".replace("100", <newPort>)
    //   would match the FIRST occurrence of "100" in the string → "192.168.<newPort>.100:100:80"
    //   corrupting the IP octet instead of the port.
    // New reconstruct: IP preserved, only the host port slot changes.
    // Port 100 is below PORT_RANGE.MIN (3000) so findAvailablePort bumps it to 3000.
    const result = out.services.db.ports[0] as string
    expect(result).toMatch(/^192\.168\.100\.100:\d+:80$/) // IP always intact
    expect(result).not.toMatch(/^192\.168\.\d+\.\d+:\d+:\d+$/.source.replace("192\\.168\\.", ""))
    // Confirm the actual value: 192.168.100.100:3000:80
    expect(result).toBe("192.168.100.100:3000:80")
  })

  it("host port 192 with IP 192.168.1.1 is reconstructed correctly", () => {
    const cfg: ComposeConfig = {
      services: { web: { image: "nginx", ports: ["192.168.1.1:192:80"] } },
    }
    const out = adjustPortsInCompose(cfg, [192])
    // new host port will be 3000 (bump from 192 to PORT_RANGE.MIN since 193 < MIN)
    // Important: IP must be preserved
    expect(out.services.web.ports[0]).toMatch(/^192\.168\.1\.1:\d+:80$/)
    expect(out.services.web.ports[0]).not.toMatch(/^\d+\.\d+\.\d+\.3000:\d+:80$/)
  })

  it("no-IP simple mapping is still handled correctly after reconstruction", () => {
    const cfg: ComposeConfig = {
      services: { web: { image: "nginx", ports: ["3000:80"] } },
    }
    const out = adjustPortsInCompose(cfg, [3000])
    expect(out.services.web.ports[0]).toBe("3001:80")
  })

  it("IP + proto suffix is fully preserved in reconstruction", () => {
    const cfg: ComposeConfig = {
      services: { web: { image: "nginx", ports: ["127.0.0.1:8080:80/tcp"] } },
    }
    const out = adjustPortsInCompose(cfg, [8080])
    expect(out.services.web.ports[0]).toBe("127.0.0.1:8081:80/tcp")
  })
})
