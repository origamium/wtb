# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **wtb-created volumes are now labelled `wtb.managed=true`.** Every volume wtb
  creates (cloned targets, atomic-overwrite temps) carries the label, so it is
  self-identifying regardless of project/path naming. `wtb status` now detects
  wtb-managed volumes by label (with the old name heuristic as a fallback for
  pre-label volumes) — fixing under-reporting for worktrees created with a custom
  `-p` path. Users/agents can list them with
  `docker volume ls --filter label=wtb.managed=true`.
- **`wtb reclone [branch]`** — re-run only the volume-clone phase on an existing
  worktree to recover empty/failed/stale volumes, without removing and recreating
  it (keeps uncommitted work). Reuses the create pipeline's volume logic; accepts
  `--force-volume-copy` / `--no-stop` / `--dry-run`; refuses the main worktree;
  same `N cloned/skipped/failed` summary and exit-0-on-failure contract.
- **`wtb status --json`** — machine-readable status. Emits a single structured
  object (`{ worktrees, docker }`) on stdout, valid JSON even when Docker is down
  (`docker.available: false`). Completes the agent-friendly machine-readable trio
  alongside `wtb ls --json` and `wtb ports`. Respects `--all` / `--docker-only`.
- **`wtb create --seed`** — seed instead of clone. Skips the volume-clone phase
  and runs the new `volumes.seed_command` config key in the worktree, so a
  worktree can start from a freshly seeded DB rather than a copy of main's.
  Never reads the source volume, so the source stack is left running. Requires
  `volumes.seed_command` (else exits `4`); mutually exclusive with
  `--force-volume-copy` (else exits `1`). A failed seed surfaces a loud
  data-NOT-ready banner (exit stays `0`, same contract as a failed clone).
  Completes the last "Seed instead of copy" roadmap item.
- **Docker volume auto-cloning** in `wtb create`: every named (non-`external`)
  Docker volume declared in `docker_compose_file` is now copied from the source
  project to the new worktree's project, so e.g. PostgreSQL data carries over
  without re-seeding. Volumes whose source container is running are skipped with
  a warning to avoid corruption (use `--force-volume-copy` to clone live anyway).
  Excludable via `volumes.exclude` in `wtb.yaml`. Skip the whole phase with
  `wtb create --no-volume-copy`.
- New `wtb remove --remove-volumes` flag — runs `docker compose down -v` so the
  worktree's cloned volumes are dropped together with the worktree.
- `resolveVolumeName()`, `discoverCloneableVolumes()`, `getContainersUsingVolume()`,
  `volumeExists()` exported from `src/core/docker/volume.ts` for programmatic use.

### Changed
- Centralized command error handling via new `withErrorHandling` wrapper
  (`src/cli/utils/command-helpers.ts`); all six commands now share the same
  CLIError-aware exit path.
- Added `getGitRootOrThrow()` guard in `src/core/git/repository.ts` to replace
  the duplicated `isGitRepository()` + `getGitRoot()` boilerplate across commands.
- `wtb status` now throws `CLIError` instead of calling `console.error` /
  `process.exit` directly, matching the other commands.
- `package.json#prepublishOnly` now runs the test suite in addition to clean+build,
  preventing publishes with a red test status.
- Invalid/unparseable `wtb.yaml` now exits with code `4` (`CONFIG_ERROR`) instead
  of a generic `1`, so scripts and agents can branch on a config mistake. Exit
  code `5` is documented as reserved (Docker degrades gracefully, never hard-fails).

- Added `npm run test:integration` (`e2e/integration-docker.sh`) — a real-Docker
  end-to-end check of the **auto stop-then-copy** path (a running source stack is
  stopped, cloned, and restarted), volume-clone carryover, the `wtb.managed=true`
  label, `reclone --force-volume-copy` atomic overwrite, `--seed`,
  `status --json`, `remove --remove-volumes` cleanup (verifying the clone target
  name aligns with Docker's own `down -v` project resolution — no silent
  orphans), the safety guards (`--no-stop` skips an in-use source volume without
  corruption or stopping the source; a populated target is skipped without
  `--force`, preserving its data), and the escape hatch (`--force-volume-copy`
  live-clones a running source without stopping it). 10 checks — the full
  volume-clone decision matrix. Skips cleanly when Docker is absent, so it stays
  out of the mocked unit/e2e CI suites.

### Fixed
- **`remove --remove-volumes` silently ignored.** `--remove-volumes` only acts via
  the automatic `docker compose down -v`, which is skipped under `--no-docker` or
  when `end_command` is set — so the flag did nothing, with no feedback. wtb now
  prints a clear `⚠️  --remove-volumes had no effect` warning in those cases
  (telling you to drop the volumes via your `end_command` or manually).
- **Cross-worktree port collision with the main worktree.** `create`'s env-file
  port adjustment scanned other worktrees for in-use ports but **excluded the
  main/source worktree**, so with an adjacent-port config (e.g. main `APP_PORT=3000`,
  `DB_PORT=3001`) a new worktree's `APP_PORT` could bump to 3001 and collide with
  main's running DB. The main worktree's ports are now included in the
  collision-avoidance set. (Configs with well-separated ports were unaffected.)
- **Docker Compose project-name precedence** in `resolveComposeProjectName`:
  `COMPOSE_PROJECT_NAME` now correctly beats the compose file's `name:` attribute
  (matching Docker Compose v2). The previous inversion silently resolved the wrong
  project when both were set, making volume cloning skip with a misleading
  "source volume does not exist".
- **SIGTERM safety for stop-then-copy**: a `kill` (not just Ctrl-C/SIGINT) during a
  volume clone now restarts the stopped source Compose stack before exiting.
- rsync copy failures now include the captured rsync stderr in the thrown error
  instead of an opaque "exit code N".
- The rsync→`cp` fallback now starts from a clean target, discarding any partial
  tree a failed rsync left behind.

## [1.0.1] – 2026-05-03

### Changed
- Rename: package `@schemelisp/wturbo` → `@schemelisp/wtb`,
  CLI binary `wturbo` → `wtb`, config files `wturbo.yaml` → `wtb.yaml`,
  env-var prefix `WTURBO_` → `WTB_`, and all internal identifiers
  (`WtbConfig`, `isWtbContainer`, …). No backwards-compat fallbacks.
- Repository URLs in `package.json` updated to `github.com/origamium/wtb`.
- Claude Code skill template moved to `templates/claude/skills/wtb/`.

## [1.0.0]

### Added
- `wtb create <branch>` — create git worktree with file copy/link, env adjustment,
  Docker Compose port collision avoidance, and lifecycle scripts.
- `wtb remove <branch>` — teardown including optional `end_command` and
  `docker compose down`.
- `wtb ls` — list worktrees with default/long/JSON/paths output modes.
- `wtb ports` — print adjusted ports and endpoints, JSON by default.
- `wtb status` — show worktree and Docker container/volume state.
- `wtb init-claude` — install Claude Code skill template (`.claude/skills/wtb/`).
- 7-phase create pipeline with `--no-docker`, `--no-env`, `--no-copy`, `--no-link`,
  `--no-start`, and `--dry-run` flags.

[Unreleased]: https://github.com/origamium/wtb/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/origamium/wtb/releases/tag/v1.0.1
[1.0.0]: https://github.com/origamium/wtb/releases/tag/v1.0.0
