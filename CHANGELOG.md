# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`wtb create --strict` / `wtb reclone --strict`** — opt-in non-zero exit when a
  volume clone (or the `--seed` command) fails. Default stays exit `0` (the worktree
  exists), preserving the documented contract; `--strict` makes the failure exit `1`
  so CI and coding-agent pipelines can detect incomplete data isolation (the warning
  banner is unchanged, only the exit code).
- **`wtb prune`** — clean up orphaned wtb-managed Docker volumes (volumes cloned for
  worktrees that no longer exist, since `wtb remove` leaves volumes by default) plus
  leftover `*__wtbtmp_*` temp volumes from interrupted `--force-volume-copy` overwrites.
  **Dry-run by default** (lists candidates); `--yes` actually removes; `--json` for
  scripts/agents. Only `wtb.managed=true`-labelled volumes that belong to no existing
  worktree are touched; in-use volumes are skipped; live worktrees are matched by exact
  Compose project prefix so their data is never removed. This also sweeps the previously
  accepted SIGKILL temp-volume leak.
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
  `--force`, preserving its data), the escape hatch (`--force-volume-copy`
  live-clones a running source without stopping it), and `prune` orphan detection
  (an orphaned volume is detected while a live worktree's volume is spared). 11
  checks. Skips cleanly when Docker is absent, so it stays out of the mocked
  unit/e2e CI suites.

### Fixed
- **`wtb ls -l` columns stay aligned with CJK relative dates.** The AGE column width
  was measured with `.length` (code units) while padding used display width, so a
  wide relative date (e.g. `3日前` — 3 code units, 5 columns) desynced the AGE column
  and everything after it in CJK locales. AGE now uses display width like the other
  columns.
- **`wtb ls` now marks the current worktree from a subdirectory.** The `→` marker
  used an exact cwd↔worktree-path match, so running `wtb ls` from anywhere below a
  worktree root showed no marker. cwd is now resolved to its containing worktree
  (longest-prefix match), matching the documented "the worktree that contains your
  current working directory".
- **Compose host-port remapping keeps a free original port even outside 3000-9999.**
  `findAvailablePort` relocated a *free* host port that was below 3000 (e.g. `80`) or
  above 9999 (e.g. `15432`) into the search range; it now keeps any free valid port
  and only bumps occupied ones (biased into 3000-9999 to avoid privileged ports).
- **`env.adjust` keys are validated.** A key that isn't a valid POSIX env var name
  (and so could never match a `.env` entry) now produces a config warning with a
  suggested sanitized name, instead of being silently ineffective.
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
- **`.env` CRLF files no longer silently drop every entry.** `parseEnvContent` now
  splits on `\r?\n`, so Windows-authored `.env` files are parsed (previously the
  trailing `\r` defeated the `KEY=VALUE` match and `env.adjust` port remapping became
  a silent no-op).
- **`.env` values containing `#` inside quotes are preserved.** A quoted value like
  `DB_URL="postgres://…?x=1#frag"` is no longer truncated at the first `#`; an inline
  comment after the closing quote is still honored.
- **Main-repository delete/reclone guard hardened against symlinks.** `wtb remove` and
  `wtb reclone` compare the target against the git root via canonical (realpath) paths,
  so a symlinked checkout can't slip past the guard and remove/clobber the main repo.
- **Port search no longer returns an in-use port on exhaustion.** The Compose and
  `.env` port finders now scan the full `3000-9999` range instead of giving up after
  100 attempts and returning a possibly-occupied port.
- **Docker container inspection is injection-hardened.** Container ids/names are
  validated against the Docker naming pattern before being interpolated into an
  `inspect` command, and the real Docker stderr is now surfaced in the thrown error
  message instead of a duplicated, detail-free string.

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
