# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Canonical repository context (`currentRoot`, main worktree, shared Git directory) and an
  atomic per-repository create lock. Linked-worktree invocation now uses the same main config,
  copy source, default destination, Compose source fallback, and volume repository identity.
- `create --json` now includes `setupWarnings` / `setupFailures`; `prune --json` includes
  recovery `protected` temp volumes. Added `prune --discard-recovery`, which requires `--yes`.
- Versioned managed-file manifests (with legacy flat-map reads) and versioned, atomically
  persisted volume-overwrite recovery records under the shared Git directory.

### Changed
- All configured file paths are repository-relative. Absolute paths, `..`, repository-root or
  `.git` targets, normalized duplicates, nested links, and link/write ancestor conflicts now
  fail as configuration errors (exit `4`). Move external inputs under a gitignored path in the
  main worktree and reference that relative path.
- Existing-branch Compose setup starts from the target checkout and only falls back to the main
  copy when absent. Port allocation supports IPv4/IPv6 short syntax and single-value long-form
  `published`, shares Docker + every sibling env/Compose reservation, and fails on ranges,
  host networking, or exhaustion instead of silently retaining an unsafe mapping.
- Real copy/link/env/Compose/start failures keep the created worktree, suppress the success
  banner, and make JSON `ok:false`; default exit remains `0`, while `--strict` exits `1`.
- `remove --json` always emits one object and includes `cleanupErrors`. Cleanup failure now keeps
  the worktree and exits non-zero; `--force` may remove it but still reports
  `removed:true, ok:false` (Docker teardown exit `5`, end/other cleanup exit `1`). Explicit `--no-docker` and
  `--no-end` remain successful skips.
- `npm test`, `npm run test:run`, and `npm run test:e2e` build first so E2E never runs stale
  `dist`; the package-lock root version now matches `1.2.0`.

### Fixed
- File replacement is transactional, and Compose/env/managed manifests use same-directory
  write + fsync + rename while preserving existing modes. Corrupt manifests fail closed;
  skip-worktree bits are restored on every retained-worktree path when file content still
  matches the recorded SHA; locked worktrees are rejected before cleanup.
- Volume targets now require matching `wtb.repo`, `wtb.project`, and `wtb.branch` ownership;
  foreign or data-bearing unmanaged targets are never overwritten, even with force. Destructive
  overwrite requires exact source/stage byte counts and preserves verified temp data through a
  recovery record before clearing the target.
- `prune` uses the main config's exact Compose path and new ownership labels, conservatively
  retains a volume while either its project or branch is still live, protects recovery temp
  volumes, and fails closed if config, worktrees, Compose ownership, recovery records, or Docker
  inspection cannot be resolved. Legacy owner-less volumes alone use the old project-prefix
  fallback.

## [1.2.0] - 2026-07-07

### Added
- **`wtb up [branch]` / `wtb down [branch] [--remove-volumes] [--json]`** — start/stop a
  worktree's Compose stack with the worktree's own compose file (`-f`) and project name
  (`-p`) always explicit. Shell-only `COMPOSE_PROJECT_NAME` is rejected; stable worktree `.env`
  values are supported, and same-project resolution still hard-fails. Refuses the
  main repository worktree. `--json` emits one object
  (`{ branch, path, composeFile, project, action, ok }`; `down` adds `volumesRemoved`) —
  the `project` field is the handle for follow-up `docker compose -p <project>` commands.
- **`wtb remove --json`** — one machine-readable object on stdout
  (`{ branch, path, removed, forced, composeDown, endCommand, ok }`), with
  `composeDown.skippedReason` naming why teardown didn't run. Exit code is unchanged;
  `ok: false` signals a failed teardown/end command.
- **`examples/compose-identity`** — runnable example of per-worktree Compose identity
  isolation (fixed `name:`/`container_name:` stacks).

### Fixed
- **`wtb reclone` (and the new `up`/`down`) now work from inside a linked worktree.**
  They previously resolved the "source repository" via `git rev-parse --show-toplevel`,
  which inside a worktree returns the worktree itself — so the main-repo guard always
  fired and the documented "default: the current worktree" could never succeed. They now
  resolve the main worktree root via `--git-common-dir`. cwd-based worktree resolution
  also canonicalizes paths (symlinked `/tmp` etc.) and picks the deepest match when a
  worktree is nested under the main repository directory.
- **`wtb remove` no longer risks tearing down the SOURCE stack.** `docker compose down`
  now passes an explicit `-p <worktree-project>`. It rejects shell-only
  `COMPOSE_PROJECT_NAME` and refuses teardown when stable `.env`/`name:` still resolves to
  the source project, which previously could stop — and with `--remove-volumes` delete —
  the source project's volumes.
- **Port propagation no longer corrupts container ports in compose `ports:`.** A mapping
  like `"5432:5432"` (or `${VAR:-5432}:5432`) is no longer rewritten on its container side;
  parseable literal mappings are left to the port-adjuster, and only `${VAR:-default}`
  host-port defaults are propagated. Also fixes a chained-map double-hop on env values.
- **Compose port allocation now also avoids ports held by stopped sibling worktrees and by
  the env phase's own just-assigned ports**, not just currently-running containers,
  preventing silent host-port collisions between worktrees.
- **`--force-volume-copy` refuses to overwrite a pre-existing volume that isn't
  `wtb.managed`**, so an unrelated volume that happens to share the target name is never
  wiped; an overwrite also requires `--force-volume-copy` even if the target only gains data
  after planning (TOCTOU guard).
- **`wtb prune` is scoped to the current repository** via a new `wtb.repo` volume label, so
  it can no longer delete another repo's live wtb volumes on the same host. Volumes created
  before this release lack the label and are left untouched.
- **`wtb doctor` accuracy**: downgrade-to-`info` now matches what create actually does — it
  accounts for `docker_compose_file` being unset, keys container-name findings on
  `compose.container_name` (not `isolate_name`), and no longer claims a literal
  `HOST:CONTAINER` mapping is auto-fixed by propagation. New finding ids: `compose-file-env`,
  `compose-override-file`, `fixed-volume-name`, `fixed-network-name`,
  `unsupported-compose-port`.
- **YAML merge keys (`<<: *anchor`) are now resolved** when reading compose files, so
  anchored `ports`/`container_name` are isolated instead of silently passing through.
- **Interrupted volume clones report their outcome**: a Ctrl-C during the
  stop → clone → restart window now prints whether the source stack came back and the exact
  recovery command if it did not.
- Worktree slugs that collapse to the same value (e.g. unicode-only branches) are
  disambiguated with a short hash to prevent cross-worktree identity collisions.
- A failed compose rewrite is now reflected in the create banner, `--json` (`composeFailed`,
  `ok:false`), and `--strict` exit code instead of silently reporting success.
- Hardening: recovery/lifecycle commands are shell-quoted; `git` operands are protected with
  `--end-of-options`; a blocked `wtb remove` restores managed-file skip-worktree bits; and
  non-ASCII managed paths no longer permanently block `wtb remove`.
- **YAML 1.1 danger-quoting now also protects sequence items** — a rewritten compose value
  like `command: [yes, on]` is quoted, so Docker's YAML 1.1 parser no longer coerces the
  items to booleans.

### Removed
- Dead exports: `generateProjectName`, `validateComposeConfig`,
  `backupEnvFile`/`restoreEnvFile`, `getContainerVolumes`/`getContainerNetworks`,
  `isWorktree`/`getWorktreeRelationship`, and the unused `ContainerInfo.volumes`/`.networks`
  fields.

## [1.1.0] - 2026-06-13

### Added
- **`wtb doctor [--json] [--strict]`** — static preflight (no Docker needed) that
  inspects the repo's compose + env files for worktree-relocatability problems.
  Findings are `{ id, severity (info|warning|error), message, suggestion }`; ids:
  `fixed-project-name`, `container-name`, `literal-env-port`, `literal-compose-port`,
  `unresolved-port-variable`, `compose-project-name-env`, `no-compose-file`. A
  finding is downgraded to `info` when the relevant auto-handling (identity rewrite /
  port propagation) is enabled (the default) and is a `warning` when disabled.
  **Default exits `0` even with warnings** (agent/CI friendly — the JSON `ok`/`summary`
  carry the result); `--strict` exits `1` if any warning-or-error finding exists.
  `--json` prints exactly one JSON object to stdout. The same checks run automatically
  during `wtb create` (and `--dry-run`) as a preflight, printing warning/error findings
  to stderr without ever changing create's exit code.
- **Per-worktree Docker Compose identity isolation** (new `compose:` config section,
  **default ON**). `compose.isolate_name: true` rewrites the compose top-level `name:`
  (project name) per worktree to `<original>-<branch-slug>`, and
  `compose.container_name` (`suffix` | `strip` | `keep`, default `suffix`) controls how
  each service's `container_name:` is handled. This is the headline fix: stacks with a
  fixed `name:`/`container_name:` (e.g. Supabase CLI output) now actually isolate across
  worktrees instead of colliding. Opt out with `compose.isolate_name: false` /
  `container_name: keep`.
- **Port propagation** (new `env.port_propagation` config, **default ON**). After wtb
  bumps a numeric (PORT-marker) env var, it propagates the old → new port into (a) other
  values in the env files that embed that port (e.g.
  `API_EXTERNAL_URL=http://127.0.0.1:54321` follows the bump) and (b) the copied compose
  file's `${VAR:-default}` defaults and string port/environment values. Accepts a boolean
  shorthand or an object `{ enabled, files, compose }`; `files` adds extra propagation
  targets beyond `env.file`. Boundary-safe: only a port immediately preceded by `:` and
  followed by a URL/list/quote boundary is rewritten — a bare `5432` inside `54321` is
  never touched. Disable with `port_propagation: false`.
- **`wtb ports` resolves `${VAR}` / `${VAR:-default}` in compose port mappings** —
  statically, against the worktree's env files (no Docker, no running stack). Mappings
  like `'${KONG_HTTP_PORT:-54321}:8000'` previously yielded empty endpoints; they now
  resolve. Precedence: worktree env-file value > compose default > unresolved (skipped,
  with a stderr warning naming the variable). Not resolved: nested defaults
  `${A:-${B}}`, port ranges, and IPv6.
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
- **Per-worktree compose rewrite is now default ON** (behavior change). The worktree's
  `docker-compose.yml` is rewritten in place — project name (`compose.isolate_name`),
  container names (`compose.container_name`), and, with propagation, `${VAR:-default}`
  ports and embedded URLs. Stacks with a fixed `name:`/`container_name:` now isolate
  across worktrees instead of colliding. Opt out with `compose.isolate_name: false`.
  Note: the worktree compose copy is reformatted by the YAML writer (comments not
  preserved in the compose file; env files DO preserve comments).
- **Port propagation is now default ON** (behavior change). Bumped ports propagate into
  other env-file values and the compose copy (see Added). Opt out with
  `port_propagation: false`.
- **Rewritten tracked files are marked git `skip-worktree`** — the worktree's compose
  copy and any adjusted/propagated env files that are git-tracked, so the per-worktree
  rewrites stay out of `git status`, don't block `wtb remove`, and aren't accidentally
  committed back. To intentionally commit such a file, run
  `git update-index --no-skip-worktree <file>` first.
- **Port search now spans the full range above 9999.** Previously the free-port search
  was capped at 9999, so a port like `54321` fell back to `original + 1` *without*
  checking occupancy and could collide with a running stack. The search now extends to
  65535, consults docker-published ports (`docker ps`) in addition to other worktrees'
  env files, and never returns an in-use port when a free one exists.
- **Volume clone is safer** (behavior change). wtb now computes the full per-volume clone
  plan *before* stopping the source stack, and only stops it if at least one volume will
  actually be cloned (previously it could stop the source stack, clone nothing, and fail
  to restart — leaving the dev environment down). Volumes held by a *different* Compose
  project are skipped without stopping, and a defensive guard refuses to clone when source
  and target resolve to the same volume name. Restart now tries `docker compose start`
  then falls back to `up -d`; **if both fail, `wtb create` / `wtb reclone` now exit with
  code `5` (DOCKER_ERROR) even without `--strict`** and print the exact recovery command,
  because a failed restart leaves the user's running source environment broken. JSON
  output gains a
  `sourceStack: { stopped, restarted, stopError?, restartError?, recoverCommand? }`
  object. A failed or timed-out `compose stop` is treated as potentially partial: wtb
  always attempts to restore the source stack and reports the affected volume clones as
  failures instead of successful skips.
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
- The low-level Compose resolver follows `COMPOSE_PROJECT_NAME > name: > basename`, but wtb
  setup/lifecycle commands reject a shell-only override; stable worktree `.env` values remain supported.
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

[Unreleased]: https://github.com/origamium/wtb/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/origamium/wtb/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/origamium/wtb/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/origamium/wtb/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/origamium/wtb/releases/tag/v1.0.1
[1.0.0]: https://github.com/origamium/wtb/releases/tag/v1.0.0
