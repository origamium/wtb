import { beforeEach, describe, expect, it, vi } from "vitest"
import { execDockerSafe } from "../../utils/exec.js"
import { assertDockerComposeProjectOwnedByWorktree } from "./project-ownership.js"

vi.mock("../../utils/exec.js", () => ({ execDockerSafe: vi.fn() }))

describe("assertDockerComposeProjectOwnedByWorktree", () => {
  beforeEach(() => {
    vi.mocked(execDockerSafe).mockReset()
  })

  it("allows a project with no existing running or stopped containers", () => {
    vi.mocked(execDockerSafe).mockReturnValue("")
    expect(() =>
      assertDockerComposeProjectOwnedByWorktree("feature", "/repo/wt", "compose.yml")
    ).not.toThrow()
  })

  it("accepts existing containers owned by the exact worktree and Compose file", () => {
    vi.mocked(execDockerSafe)
      .mockReturnValueOnce("abc123")
      .mockReturnValueOnce(
        JSON.stringify({
          "com.docker.compose.project": "feature",
          "com.docker.compose.project.working_dir": "/repo/wt",
          "com.docker.compose.project.config_files": "/repo/wt/compose.yml",
        })
      )
    expect(() =>
      assertDockerComposeProjectOwnedByWorktree("feature", "/repo/wt", "compose.yml")
    ).not.toThrow()
  })

  it("accepts the strict same-directory snapshot label written by wtb up", () => {
    vi.mocked(execDockerSafe)
      .mockReturnValueOnce("abc123")
      .mockReturnValueOnce(
        JSON.stringify({
          "com.docker.compose.project": "feature",
          "com.docker.compose.project.working_dir": "/repo/wt",
          "com.docker.compose.project.config_files":
            "/repo/wt/.compose.yml.wtb-snapshot-42-123e4567-e89b-12d3-a456-426614174000.yml",
        })
      )
    expect(() =>
      assertDockerComposeProjectOwnedByWorktree("feature", "/repo/wt", "compose.yml")
    ).not.toThrow()
  })

  it("rejects an otherwise-owned project with an additional unknown config file", () => {
    vi.mocked(execDockerSafe)
      .mockReturnValueOnce("abc123")
      .mockReturnValueOnce(
        JSON.stringify({
          "com.docker.compose.project": "feature",
          "com.docker.compose.project.working_dir": "/repo/wt",
          "com.docker.compose.project.config_files":
            "/repo/wt/compose.yml,/foreign/override.yml",
        })
      )
    expect(() =>
      assertDockerComposeProjectOwnedByWorktree("feature", "/repo/wt", "compose.yml")
    ).toThrow(/owned by another worktree or Compose file/)
  })

  it("rejects a stopped project left behind by another worktree", () => {
    vi.mocked(execDockerSafe)
      .mockReturnValueOnce("foreign123")
      .mockReturnValueOnce(
        JSON.stringify({
          "com.docker.compose.project": "feature",
          "com.docker.compose.project.working_dir": "/repo/old-worktree",
          "com.docker.compose.project.config_files": "/repo/old-worktree/compose.yml",
        })
      )
    expect(() =>
      assertDockerComposeProjectOwnedByWorktree("feature", "/repo/wt", "compose.yml")
    ).toThrow(/owned by another worktree or Compose file/)
  })

  it("fails closed when Docker project ownership cannot be inspected", () => {
    vi.mocked(execDockerSafe).mockImplementation(() => {
      throw new Error("daemon unavailable")
    })
    expect(() =>
      assertDockerComposeProjectOwnedByWorktree("feature", "/repo/wt", "compose.yml")
    ).toThrow(/daemon unavailable/)
  })
})
