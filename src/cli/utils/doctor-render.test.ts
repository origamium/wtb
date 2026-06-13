/**
 * @fileoverview doctor-render.ts のユニットテスト
 */

import { describe, expect, it } from "vitest"
import type { RelocatabilityReport } from "../../core/docker/relocatability.js"
import { renderDoctorJson, renderDoctorPretty } from "./doctor-render.js"

const emptyReport = (): RelocatabilityReport => ({
  composeFile: null,
  findings: [],
  summary: { info: 0, warning: 0, error: 0 },
  ok: true,
})

const reportWithFindings = (): RelocatabilityReport => ({
  composeFile: "docker-compose.yml",
  findings: [
    {
      id: "fixed-project-name",
      severity: "warning",
      message: "All worktrees share Compose project 'myapp'",
      suggestion: "Enable compose.isolate_name in wtb.yaml",
    },
    {
      id: "unresolved-port-variable",
      severity: "warning",
      service: "web",
      variable: "MISSING_PORT",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional — compose interpolation syntax in test fixture
      message: "Service 'web' has an unresolved port variable ${MISSING_PORT}",
    },
    {
      id: "no-compose-file",
      severity: "info",
      message: "No compose file found — relocatability checks skipped",
    },
  ],
  summary: { info: 1, warning: 2, error: 0 },
  ok: false,
})

describe("renderDoctorJson", () => {
  it("produces valid JSON", () => {
    const output = renderDoctorJson(emptyReport())
    expect(() => JSON.parse(output)).not.toThrow()
  })

  it("round-trips the report structure", () => {
    const report = reportWithFindings()
    const parsed = JSON.parse(renderDoctorJson(report))
    expect(parsed.ok).toBe(false)
    expect(parsed.summary.warning).toBe(2)
    expect(parsed.findings).toHaveLength(3)
    expect(parsed.composeFile).toBe("docker-compose.yml")
  })

  it("does not emit extra content outside the JSON object", () => {
    const output = renderDoctorJson(emptyReport())
    // Must parse as a single JSON value (object or array), no trailing junk
    const trimmed = output.trim()
    expect(trimmed[0]).toBe("{")
    expect(trimmed[trimmed.length - 1]).toBe("}")
  })
})

describe("renderDoctorPretty", () => {
  it("shows '✅ no relocatability issues' for a clean report", () => {
    const output = renderDoctorPretty(emptyReport())
    expect(output).toContain("✅ no relocatability issues")
  })

  it("ends with a newline", () => {
    expect(renderDoctorPretty(emptyReport())).toMatch(/\n$/)
    expect(renderDoctorPretty(reportWithFindings())).toMatch(/\n$/)
  })

  it("includes the compose file name when present", () => {
    const output = renderDoctorPretty(reportWithFindings())
    expect(output).toContain("compose: docker-compose.yml")
  })

  it("shows the finding id and message", () => {
    const output = renderDoctorPretty(reportWithFindings())
    expect(output).toContain("[fixed-project-name]")
    expect(output).toContain("All worktrees share Compose project")
  })

  it("shows suggestions prefixed with →", () => {
    const output = renderDoctorPretty(reportWithFindings())
    expect(output).toContain("→ Enable compose.isolate_name")
  })

  it("shows summary line with warning count", () => {
    const output = renderDoctorPretty(reportWithFindings())
    expect(output).toContain("2 warnings")
    expect(output).toContain("1 info")
  })

  it("shows '1 warning' (singular) for exactly one warning", () => {
    const report: RelocatabilityReport = {
      composeFile: null,
      findings: [
        {
          id: "container-name",
          severity: "warning",
          message: "Service db has container_name",
        },
      ],
      summary: { info: 0, warning: 1, error: 0 },
      ok: false,
    }
    const output = renderDoctorPretty(report)
    expect(output).toContain("1 warning")
    expect(output).not.toContain("1 warnings")
  })

  it("uses ⚠️  icon for warnings", () => {
    const output = renderDoctorPretty(reportWithFindings())
    expect(output).toContain("⚠️ ")
  })

  it("uses ℹ️  icon for info", () => {
    const output = renderDoctorPretty(reportWithFindings())
    expect(output).toContain("ℹ️ ")
  })
})
