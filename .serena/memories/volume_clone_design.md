# Volume Auto-Clone Design (v1.1.0)

## Problem this solves

Without wtb, every new git worktree starts with empty Docker volumes — meaning `wtb create feature/x` would give you a fresh PostgreSQL with no data. Users had to manually `pg_dump | pg_restore` or run seed scripts. v1.1.0 makes the new worktree start with the same volume contents the source project has.

## High-level architecture

`wtb create` runs a phase 6.5 (`setupVolumeCopy` in `src/cli/commands/create.ts`) between Compose adjustment (phase 6) and `start_command` execution (phase 7). It:

1. Reads `compose.volumes` from `docker_compose_file`
2. Auto-discovers candidate volumes: every named volume that is **not** `external: true` and not in `volumes.exclude`
3. Resolves source / target volume names using `resolveComposeProjectName` (Compose-spec correct)
4. For each candidate, runs three guards (skip+warn unless `--force-volume-copy`):
   - source volume must exist (`volumeExists`)
   - no running container may be using the source (`getContainersUsingVolume`)
   - target must be empty (`getVolumeSize == 0`)
5. Copies via `copyVolume(source, target, { onProgress, clearTarget })`

## Why "auto-discovery, opt-out" and not "explicit list"

The user's stated requirement was *"docker compose ファイルにあるものは可能な限りコピーして立ち上げられるように"* — single source of truth is the compose file. Asking the user to maintain a parallel `volumes.copy: [...]` list invites drift. Instead, `volumes.exclude: [...]` lets users say "skip this regenerable cache" while keeping the default behavior trivial.

External volumes (`external: true`) are skipped because the user explicitly marked them as shared / managed elsewhere — cloning them would violate that intent.

## Why containers and networks are NOT copied

Compose creates fresh containers and networks per project automatically (`<project>_default` network, `<project>-<service>-<index>` containers). All wtb has to do is make sure the project name differs between source and target — and it does, because the worktree directory differs.

Volumes are different: their *data* is what users care about, and Compose only creates an empty volume per project by default. So volumes are the only thing that needs explicit copying.

## Copy engine (rsync sidecar with cp fallback)

`copyVolume` in `src/core/docker/volume.ts`:

- **Primary**: `instrumentisto/rsync-ssh` Docker image, with `--info=progress2` parsed for live progress display. Supports `--delete` (when `clearTarget` true / `incremental` true).
- **Fallback**: `alpine` + `cp -a /source/. /target/`. Triggered when rsync throws (e.g. image not pullable).

Both implementations mount source as `:/source:ro` and target as `:/target` in a transient `--rm` container.

### `clearTarget` semantics

`--force-volume-copy` promised to overwrite a populated target — but the cp fallback originally just appended files (because `cp -a` doesn't delete extras). Caught by Copilot review on PR #8.

Fix: `copyVolume` now takes `clearTarget?: boolean`. When true:
- rsync path uses `incremental: true` → `--delete`
- cp path runs `find /target -mindepth 1 -delete` in a separate Alpine sidecar before the cp

`setupVolumeCopy` only sets `clearTarget: true` when `force=true` **and** the target is populated (`getVolumeSize > 0`). Empty / missing targets don't need the extra sidecar.

## Live-source guard

If a container is currently mounting the source volume (e.g. user has `docker compose up` on main), the copy is **unsafe** for stateful services (Postgres / MySQL / Redis can corrupt). `setupVolumeCopy` detects this via `getContainersUsingVolume(source.name)` and either:

- **Default**: skip this volume with an actionable message (stop the source side via `docker compose down`, or pass `--force-volume-copy`)
- **`--force-volume-copy`**: clone live; user has acknowledged the risk

## Project name resolution (Compose-spec correct)

Volume name resolution depends on knowing the Compose project name exactly as Compose itself computes it. Use `resolveComposeProjectName(composeConfig, workdir, env=process.env)` from `src/core/docker/compose.ts`. **Do NOT use `generateProjectName`** — its dash-replacement rule is a wrong approximation that silently breaks for any directory containing `_` or `.`.

See `compose_project_name_rules` memory for the exact rules and precedence.

## `wtb remove` does not delete volumes by default

To match plain `docker compose down` semantics, removal preserves the cloned volumes. Pass `wtb remove <branch> --remove-volumes` to invoke `down -v` instead. This way users can iterate (`wtb create` + `wtb remove`) without losing data accidentally.

## Test layout

- `src/core/docker/volume.test.ts` — leaf helpers (`resolveVolumeName`, `discoverCloneableVolumes`, `formatBytes`, `formatEta`)
- `src/core/docker/compose.test.ts` — `resolveComposeProjectName` (16 tests covering normalization edge cases + COMPOSE_PROJECT_NAME)
- `src/cli/commands/create.volume.test.ts` — `setupVolumeCopy` orchestration with mocked compose/volume modules (11 scenarios: skip 4 / force 2 / success / failure / exclude / summary)

The actual rsync and cp sidecars are exercised only by manual e2e (Docker required); see `suggested_commands` memory for the Postgres test recipe.

## Known limitations / future work

- `instrumentisto/rsync-ssh` image is third-party and used unpinned (`:latest`) — consider tagging
- For first-run repos with no source data, both paths produce useful errors; for repos with huge data (>10 GB) the rsync image pull is a noticeable startup cost
- `--force-volume-copy` overloads two distinct risks (live source vs target overwrite); could split into `--force-clone-live` and `--force-overwrite-target` later
- DB-aware `pg_dump | pg_restore` is out of scope; transactional consistency requires the user to stop the source first (the default safe path)
