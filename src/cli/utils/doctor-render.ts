/**
 * @fileoverview `wtb doctor` 用 pure renderer
 */
import type { RelocatabilityReport } from "../../core/docker/relocatability.js"

export function renderDoctorJson(report: RelocatabilityReport): string {
  return JSON.stringify(report, null, 2)
}

const SEVERITY_ICON: Record<string, string> = {
  info: "ℹ️ ",
  warning: "⚠️ ",
  error: "❌",
}

export function renderDoctorPretty(report: RelocatabilityReport): string {
  const lines: string[] = []

  if (report.composeFile) {
    lines.push(`compose: ${report.composeFile}`)
    lines.push("")
  }

  if (report.findings.length === 0) {
    lines.push("✅ no relocatability issues")
    return `${lines.join("\n")}\n`
  }

  for (const f of report.findings) {
    const icon = SEVERITY_ICON[f.severity] ?? f.severity
    lines.push(`${icon} [${f.id}] ${f.message}`)
    if (f.suggestion) {
      lines.push(`    → ${f.suggestion}`)
    }
  }

  lines.push("")
  const parts: string[] = []
  if (report.summary.error > 0)
    parts.push(`${report.summary.error} error${report.summary.error !== 1 ? "s" : ""}`)
  if (report.summary.warning > 0)
    parts.push(`${report.summary.warning} warning${report.summary.warning !== 1 ? "s" : ""}`)
  if (report.summary.info > 0) parts.push(`${report.summary.info} info`)

  if (parts.length > 0) {
    lines.push(`${parts.join(", ")} — see suggestions above`)
  } else {
    lines.push("✅ no relocatability issues")
  }

  return `${lines.join("\n")}\n`
}
