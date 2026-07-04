/**
 * @fileoverview analyzeRelocatability のユニットテスト
 */

import { afterEach, describe, expect, it } from "vitest"
import type { ComposeConfig, WtbConfig } from "../../types/index.js"
import { analyzeRelocatability } from "./relocatability.js"

// Suppress process.env side-effects between tests
const originalEnv = { ...process.env }

afterEach(() => {
  // restore COMPOSE_PROJECT_NAME / COMPOSE_FILE between tests
  for (const key of ["COMPOSE_PROJECT_NAME", "COMPOSE_FILE"] as const) {
    if (key in originalEnv) {
      process.env[key] = originalEnv[key]
    } else {
      delete process.env[key]
    }
  }
})

const baseCfg = (over: Partial<WtbConfig> = {}): WtbConfig => ({
  base_branch: "main",
  docker_compose_file: "docker-compose.yml",
  copy_files: [],
  link_files: [],
  env: { file: [".env"], adjust: { APP_PORT: 1, DB_PORT: 1 }, port_propagation: { enabled: false, files: [], compose: false } },
  volumes: { exclude: [] },
  ...over,
})

const baseCompose = (over: Partial<ComposeConfig> = {}): ComposeConfig => ({
  services: {},
  ...over,
})

const baseOptions = {
  identityRewriteEnabled: false,
  containerNameRewriteEnabled: false,
  composePortPropagationEnabled: false,
  envPortPropagationEnabled: false,
}

describe("analyzeRelocatability", () => {
  describe("null compose → no-compose-file", () => {
    it("returns a single info finding and ok:true when compose is null", () => {
      const r = analyzeRelocatability({
        compose: null,
        composeFile: null,
        envMap: {},
        config: baseCfg(),
        options: baseOptions,
      })
      expect(r.ok).toBe(true)
      expect(r.findings).toHaveLength(1)
      expect(r.findings[0].id).toBe("no-compose-file")
      expect(r.findings[0].severity).toBe("info")
    })
  })

  describe("clean compose → ok:true", () => {
    it("returns ok:true and no findings for a clean compose with variable ports", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({
          // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
          services: { web: { ports: ["${APP_PORT:-3000}:80"] } },
        }),
        composeFile: "/repo/docker-compose.yml",
        envMap: { APP_PORT: "3001", DB_PORT: "5433" },
        config: baseCfg(),
        options: baseOptions,
      })
      expect(r.ok).toBe(true)
      expect(r.findings).toHaveLength(0)
    })
  })

  describe("fixed-project-name", () => {
    it("emits warning when identityRewriteEnabled=false", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({ name: "myapp" }),
        composeFile: "/repo/docker-compose.yml",
        envMap: {},
        config: baseCfg(),
        options: { ...baseOptions, identityRewriteEnabled: false },
      })
      const f = r.findings.find((x) => x.id === "fixed-project-name")
      expect(f).toBeDefined()
      expect(f?.severity).toBe("warning")
      expect(f?.suggestion).toBeTruthy()
      expect(r.ok).toBe(false)
    })

    it("emits info when identityRewriteEnabled=true", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({ name: "myapp" }),
        composeFile: "/repo/docker-compose.yml",
        envMap: {},
        config: baseCfg(),
        options: { ...baseOptions, identityRewriteEnabled: true },
      })
      const f = r.findings.find((x) => x.id === "fixed-project-name")
      expect(f?.severity).toBe("info")
      expect(f?.suggestion).toBeUndefined()
      expect(r.ok).toBe(true)
    })

    it("does not emit when compose.name is absent", () => {
      const r = analyzeRelocatability({
        compose: baseCompose(),
        composeFile: null,
        envMap: {},
        config: baseCfg(),
        options: baseOptions,
      })
      expect(r.findings.find((x) => x.id === "fixed-project-name")).toBeUndefined()
    })
  })

  describe("container-name", () => {
    it("emits warning for services with container_name when identityRewrite=false", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({
          services: { db: { container_name: "mydb" } },
        }),
        composeFile: null,
        envMap: {},
        config: baseCfg(),
        options: { ...baseOptions, identityRewriteEnabled: false },
      })
      const f = r.findings.find((x) => x.id === "container-name")
      expect(f?.severity).toBe("warning")
      expect(f?.message).toContain("db")
      expect(r.ok).toBe(false)
    })

    it("emits info when containerNameRewriteEnabled=true", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({
          services: { db: { container_name: "mydb" } },
        }),
        composeFile: null,
        envMap: {},
        config: baseCfg(),
        options: { ...baseOptions, containerNameRewriteEnabled: true },
      })
      const f = r.findings.find((x) => x.id === "container-name")
      expect(f?.severity).toBe("info")
    })

    it("stays warning when only identity (not container_name) rewrite is on (container_name: keep)", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({
          services: { db: { container_name: "mydb" } },
        }),
        composeFile: null,
        envMap: {},
        config: baseCfg(),
        // isolate_name on but container_name mode is 'keep' → names NOT rewritten
        options: { ...baseOptions, identityRewriteEnabled: true, containerNameRewriteEnabled: false },
      })
      const f = r.findings.find((x) => x.id === "container-name")
      expect(f?.severity).toBe("warning")
    })
  })

  describe("literal-compose-port", () => {
    it("emits warning for literal port that matches an adjusted port key", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({ services: { web: { ports: ["3001:80"] } } }),
        composeFile: null,
        envMap: { APP_PORT: "3001" },
        config: baseCfg({ env: { file: [".env"], adjust: { APP_PORT: 1 }, port_propagation: { enabled: false, files: [], compose: false } } }),
        options: baseOptions,
      })
      const f = r.findings.find((x) => x.id === "literal-compose-port")
      expect(f).toBeDefined()
      expect(f?.severity).toBe("warning")
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      expect(f?.suggestion).toContain("${APP_PORT:-3001}")
      expect(r.ok).toBe(false)
    })

    it("stays warning even when compose port propagation is enabled (propagation never rewrites literal mappings)", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({ services: { web: { ports: ["3001:80"] } } }),
        composeFile: null,
        envMap: { APP_PORT: "3001" },
        config: baseCfg({ env: { file: [".env"], adjust: { APP_PORT: 1 }, port_propagation: { enabled: true, files: [], compose: true } } }),
        options: { ...baseOptions, composePortPropagationEnabled: true },
      })
      const f = r.findings.find((x) => x.id === "literal-compose-port")
      expect(f?.severity).toBe("warning")
      expect(f?.message).toContain("won't follow")
    })

    it("does NOT flag literal ports that are not adjusted", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({ services: { web: { ports: ["9999:80"] } } }),
        composeFile: null,
        envMap: { APP_PORT: "3001" },
        config: baseCfg({ env: { file: [".env"], adjust: { APP_PORT: 1 }, port_propagation: { enabled: false, files: [], compose: false } } }),
        options: baseOptions,
      })
      expect(r.findings.find((x) => x.id === "literal-compose-port")).toBeUndefined()
    })
  })

  describe("literal-env-port heuristic", () => {
    it("emits info when propagation is enabled (embed will be updated)", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({ services: {} }),
        composeFile: null,
        envMap: { APP_PORT: "3001", API_URL: "http://localhost:3001/api" },
        config: baseCfg({ env: { file: [".env"], adjust: { APP_PORT: 1 }, port_propagation: { enabled: true, files: [], compose: true } } }),
        options: { ...baseOptions, envPortPropagationEnabled: true },
      })
      const f = r.findings.find((x) => x.id === "literal-env-port")
      expect(f).toBeDefined()
      expect(f?.severity).toBe("info")
      expect(f?.variable).toBe("API_URL")
    })

    it("emits warning when propagation is disabled (embed won't be updated)", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({ services: {} }),
        composeFile: null,
        envMap: { APP_PORT: "3001", API_URL: "http://localhost:3001/api" },
        config: baseCfg({ env: { file: [".env"], adjust: { APP_PORT: 1 }, port_propagation: { enabled: false, files: [], compose: false } } }),
        options: { ...baseOptions, envPortPropagationEnabled: false },
      })
      const f = r.findings.find((x) => x.id === "literal-env-port")
      expect(f?.severity).toBe("warning")
      expect(f?.variable).toBe("API_URL")
    })

    it("does NOT false-positive on a value that merely starts with the adjusted port (no leading colon)", () => {
      // TIMEOUT_MS=3001 must not be flagged — env propagation only rewrites ':<port>' boundaries.
      const r = analyzeRelocatability({
        compose: baseCompose({ services: {} }),
        composeFile: null,
        envMap: { APP_PORT: "3001", TIMEOUT_MS: "3001" },
        config: baseCfg({ env: { file: [".env"], adjust: { APP_PORT: 1 }, port_propagation: { enabled: false, files: [], compose: false } } }),
        options: baseOptions,
      })
      expect(r.findings.find((x) => x.id === "literal-env-port")).toBeUndefined()
    })

    it("does NOT flag the adjust env key itself", () => {
      const r = analyzeRelocatability({
        compose: baseCompose(),
        composeFile: null,
        envMap: { APP_PORT: "3001" },
        config: baseCfg({ env: { file: [".env"], adjust: { APP_PORT: 1 }, port_propagation: { enabled: false, files: [], compose: false } } }),
        options: baseOptions,
      })
      expect(r.findings.find((x) => x.id === "literal-env-port")).toBeUndefined()
    })

    it("does NOT false-positive on a port number that is a substring of a larger number", () => {
      // e.g. APP_PORT=300 should not match API_URL=http://example.com/30001
      const r = analyzeRelocatability({
        compose: baseCompose(),
        composeFile: null,
        envMap: { APP_PORT: "300", OTHER: "http://example.com/30001/path" },
        config: baseCfg({ env: { file: [".env"], adjust: { APP_PORT: 1 }, port_propagation: { enabled: false, files: [], compose: false } } }),
        options: baseOptions,
      })
      expect(r.findings.find((x) => x.id === "literal-env-port")).toBeUndefined()
    })
  })

  describe("unresolved-port-variable", () => {
    it("emits warning for a port with an unresolved variable", () => {
      const r = analyzeRelocatability({
        // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
        compose: baseCompose({ services: { web: { ports: ["${MISSING_PORT}:80"] } } }),
        composeFile: null,
        envMap: {},
        config: baseCfg(),
        options: baseOptions,
      })
      const f = r.findings.find((x) => x.id === "unresolved-port-variable")
      expect(f).toBeDefined()
      expect(f?.severity).toBe("warning")
      expect(f?.variable).toBe("MISSING_PORT")
      expect(f?.service).toBe("web")
      expect(r.ok).toBe(false)
    })

    it("does NOT emit when variable is resolved via default", () => {
      const r = analyzeRelocatability({
        // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
        compose: baseCompose({ services: { web: { ports: ["${APP_PORT:-3000}:80"] } } }),
        composeFile: null,
        envMap: {},
        config: baseCfg(),
        options: baseOptions,
      })
      expect(r.findings.find((x) => x.id === "unresolved-port-variable")).toBeUndefined()
    })
  })

  describe("COMPOSE_PROJECT_NAME env var", () => {
    it("emits warning when COMPOSE_PROJECT_NAME is set", () => {
      process.env.COMPOSE_PROJECT_NAME = "override-project"
      const r = analyzeRelocatability({
        compose: baseCompose(),
        composeFile: null,
        envMap: {},
        config: baseCfg(),
        options: baseOptions,
      })
      const f = r.findings.find((x) => x.id === "compose-project-name-env")
      expect(f).toBeDefined()
      expect(f?.severity).toBe("warning")
      expect(f?.message).toContain("override-project")
      expect(r.ok).toBe(false)
    })

    it("does not emit when COMPOSE_PROJECT_NAME is unset", () => {
      delete process.env.COMPOSE_PROJECT_NAME
      const r = analyzeRelocatability({
        compose: baseCompose(),
        composeFile: null,
        envMap: {},
        config: baseCfg(),
        options: baseOptions,
      })
      expect(r.findings.find((x) => x.id === "compose-project-name-env")).toBeUndefined()
    })
  })

  describe("unsupported-compose-port (ranges/long-form)", () => {
    it("warns on a port range that wtb can't bump", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({ services: { web: { ports: ["8000-8010:8000-8010"] } } }),
        composeFile: null,
        envMap: {},
        config: baseCfg(),
        options: baseOptions,
      })
      const f = r.findings.find((x) => x.id === "unsupported-compose-port")
      expect(f?.severity).toBe("warning")
      expect(r.ok).toBe(false)
    })

    it("does NOT warn on a bare single container port (ephemeral host port)", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({ services: { web: { ports: ["3000"] } } }),
        composeFile: null,
        envMap: {},
        config: baseCfg(),
        options: baseOptions,
      })
      expect(r.findings.find((x) => x.id === "unsupported-compose-port")).toBeUndefined()
    })
  })

  describe("fixed volume/network names", () => {
    it("warns on a non-external volume with an explicit name:", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({ volumes: { db: { name: "pgdata" } } } as Partial<ComposeConfig>),
        composeFile: null,
        envMap: {},
        config: baseCfg(),
        options: baseOptions,
      })
      const f = r.findings.find((x) => x.id === "fixed-volume-name")
      expect(f?.severity).toBe("warning")
      expect(f?.message).toContain("pgdata")
    })

    it("does NOT warn on an external volume with a name:", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({
          volumes: { db: { name: "pgdata", external: true } },
        } as Partial<ComposeConfig>),
        composeFile: null,
        envMap: {},
        config: baseCfg(),
        options: baseOptions,
      })
      expect(r.findings.find((x) => x.id === "fixed-volume-name")).toBeUndefined()
    })

    it("emits info (not warning) for a fixed network name", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({ networks: { net: { name: "shared" } } } as Partial<ComposeConfig>),
        composeFile: null,
        envMap: {},
        config: baseCfg(),
        options: baseOptions,
      })
      const f = r.findings.find((x) => x.id === "fixed-network-name")
      expect(f?.severity).toBe("info")
    })
  })

  describe("environment overrides", () => {
    it("warns when COMPOSE_FILE is set", () => {
      process.env.COMPOSE_FILE = "docker-compose.yml:docker-compose.prod.yml"
      const r = analyzeRelocatability({
        compose: baseCompose(),
        composeFile: null,
        envMap: {},
        config: baseCfg(),
        options: baseOptions,
      })
      const f = r.findings.find((x) => x.id === "compose-file-env")
      expect(f?.severity).toBe("warning")
    })

    it("warns for each discovered override file", () => {
      const r = analyzeRelocatability({
        compose: baseCompose(),
        composeFile: "/repo/docker-compose.yml",
        envMap: {},
        config: baseCfg(),
        options: baseOptions,
        overrideFiles: ["docker-compose.override.yml"],
      })
      const f = r.findings.find((x) => x.id === "compose-override-file")
      expect(f?.severity).toBe("warning")
      expect(f?.message).toContain("docker-compose.override.yml")
    })
  })

  describe("summary counts", () => {
    it("counts findings by severity correctly", () => {
      process.env.COMPOSE_PROJECT_NAME = "proj"
      const r = analyzeRelocatability({
        compose: baseCompose({ name: "myapp", services: { db: { container_name: "c" } } }),
        composeFile: null,
        envMap: {},
        config: baseCfg(),
        options: { ...baseOptions, identityRewriteEnabled: false },
      })
      // fixed-project-name (warning) + container-name (warning) + compose-project-name-env (warning)
      expect(r.summary.warning).toBeGreaterThanOrEqual(3)
      expect(r.summary.error).toBe(0)
      expect(r.ok).toBe(false)
    })
  })
})
