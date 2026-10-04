import { afterEach, describe, expect, it, vi } from "vitest"
import { CLIError } from "../../utils/error.js"
import { installOrcaHooks } from "../utils/orca-install.js"
import { executeInitOrcaCommand, initOrcaCommand } from "./init-orca.js"

vi.mock("../utils/orca-install.js", async (original) => ({
  ...(await original<typeof import("../utils/orca-install.js")>()),
  installOrcaHooks: vi.fn(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  process.exitCode = undefined
})

describe("init-orca command", () => {
  it("exposes install and inspection flags", () => {
    const flags = initOrcaCommand().options.map((option) => option.long)
    expect(flags).toEqual(
      expect.arrayContaining(["--remove-volumes", "--check", "--dry-run", "--force", "--json"])
    )
  })

  it("prints exactly one JSON error for early failures", async () => {
    vi.mocked(installOrcaHooks).mockRejectedValue(new CLIError("Not in a git repository", 3))
    const output = vi.spyOn(console, "log").mockImplementation(() => {})
    await executeInitOrcaCommand({ json: true })
    expect(output).toHaveBeenCalledTimes(1)
    expect(JSON.parse(output.mock.calls[0][0])).toEqual({
      ok: false,
      error: "Not in a git repository",
      exitCode: 3,
    })
    expect(process.exitCode).toBe(3)
  })

  it("check mismatch returns JSON and exits one without throwing", async () => {
    vi.mocked(installOrcaHooks).mockResolvedValue({
      path: "/repo/orca.yaml",
      existed: false,
      changed: true,
      wrote: false,
      check: true,
      dryRun: false,
      removeVolumes: false,
      differences: ["scripts.setup"],
      ok: false,
    })
    const output = vi.spyOn(console, "log").mockImplementation(() => {})
    await executeInitOrcaCommand({ check: true, json: true })
    expect(output).toHaveBeenCalledTimes(1)
    expect(JSON.parse(output.mock.calls[0][0]).ok).toBe(false)
    expect(process.exitCode).toBe(1)
  })
})
