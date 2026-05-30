import { describe, expect, it } from "vitest"
import type { ComposeConfig } from "../../types/index.js"
import {
  adjustPortsInCompose,
  findAvailablePort,
  parsePortMapping,
  resolveComposeProjectName,
} from "./compose"

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
    expect(resolveComposeProjectName(empty(), "/tmp/wtb-vc-real.hk4L")).toBe(
      "wtb-vc-realhk4l",
    )
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
    expect(parsePortMapping("0.0.0.0:3000:80")).toEqual({ hostPort: 3000, containerPort: 80 })
    expect(parsePortMapping("127.0.0.1:5432:5432")).toEqual({ hostPort: 5432, containerPort: 5432 })
  })

  it("parses an optional /tcp or /udp protocol suffix", () => {
    expect(parsePortMapping("3000:80/tcp")).toEqual({ hostPort: 3000, containerPort: 80 })
    expect(parsePortMapping("6379:6379/udp")).toEqual({ hostPort: 6379, containerPort: 6379 })
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
      { services: { a: { image: "x", ports: ["3000:80"] }, b: { image: "y", ports: ["3000:80"] } } },
      [],
    )
    const all = [...out.services.a.ports, ...out.services.b.ports]
    expect(all).toEqual(["3000:80", "3001:80"])
  })

  it("leaves unparseable mappings (e.g. ranges) untouched rather than corrupting them", () => {
    const out = adjustPortsInCompose(cfg(["5000-6000:5000-6000"]), [5000])
    expect(out.services.web.ports).toEqual(["5000-6000:5000-6000"])
  })
})
