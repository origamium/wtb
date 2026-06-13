/**
 * @fileoverview analyzeRelocatability のユニットテスト
 */

import { afterEach, describe, expect, it } from "vitest"
import type { ComposeConfig, WtbConfig } from "../../types/index.js"
import { analyzeRelocatability } from "./relocatability.js"

// Suppress process.env side-effects between tests
const originalEnv = { ...process.env }

afterEach(() => {
  // restore COMPOSE_PROJECT_NAME between tests
  if ("COMPOSE_PROJECT_NAME" in originalEnv) {
    process.env.COMPOSE_PROJECT_NAME = originalEnv.COMPOSE_PROJECT_NAME
  } else {
    delete process.env.COMPOSE_PROJECT_NAME
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

const baseOptions = { identityRewriteEnabled: false, portPropagationEnabled: false }

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

    it("emits info when identityRewrite=true", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({
          services: { db: { container_name: "mydb" } },
        }),
        composeFile: null,
        envMap: {},
        config: baseCfg(),
        options: { ...baseOptions, identityRewriteEnabled: true },
      })
      const f = r.findings.find((x) => x.id === "container-name")
      expect(f?.severity).toBe("info")
    })
  })

  describe("literal-compose-port", () => {
    it("emits warning for literal port that matches an adjusted port key", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({ services: { web: { ports: ["3001:80"] } } }),
        composeFile: null,
        envMap: { APP_PORT: "3001" },
        config: baseCfg({ env: { file: [".env"], adjust: { APP_PORT: 1 }, port_propagation: { enabled: false, files: [], compose: false } } }),
        options: { ...baseOptions, portPropagationEnabled: false },
      })
      const f = r.findings.find((x) => x.id === "literal-compose-port")
      expect(f).toBeDefined()
      expect(f?.severity).toBe("warning")
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      expect(f?.suggestion).toContain("${APP_PORT:-3001}")
      expect(r.ok).toBe(false)
    })

    it("emits info instead of warning when portPropagationEnabled=true", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({ services: { web: { ports: ["3001:80"] } } }),
        composeFile: null,
        envMap: { APP_PORT: "3001" },
        config: baseCfg({ env: { file: [".env"], adjust: { APP_PORT: 1 }, port_propagation: { enabled: true, files: [], compose: true } } }),
        options: { ...baseOptions, portPropagationEnabled: true },
      })
      const f = r.findings.find((x) => x.id === "literal-compose-port")
      expect(f?.severity).toBe("info")
      // Message should be reassuring (not say "won't follow") when propagation is enabled (M3)
      expect(f?.message).toContain("port propagation is enabled")
      expect(f?.message).not.toContain("won't follow")
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
    it("emits info when a non-adjust env var embeds an adjusted port", () => {
      const r = analyzeRelocatability({
        compose: baseCompose({ services: {} }),
        composeFile: null,
        envMap: { APP_PORT: "3001", API_URL: "http://localhost:3001/api" },
        config: baseCfg({ env: { file: [".env"], adjust: { APP_PORT: 1 }, port_propagation: { enabled: false, files: [], compose: false } } }),
        options: baseOptions,
      })
      const f = r.findings.find((x) => x.id === "literal-env-port")
      expect(f).toBeDefined()
      expect(f?.severity).toBe("info")
      expect(f?.variable).toBe("API_URL")
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
