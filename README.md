# wtb

**Switch between multiple branch environments in an instant.**

A CLI tool built on Git worktrees that gives every branch its own isolated working directory — with automatic `.env` copying, port remapping, Docker Compose isolation, **Docker volume cloning so each branch starts with the same data your main worktree has**, and symlinks for heavy directories like `node_modules`.

[![npm version](https://img.shields.io/npm/v/@schemelisp/wtb.svg)](https://www.npmjs.com/package/@schemelisp/wtb)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

[日本語 / Japanese README](README_ja.md)

---

## Table of contents

- [Why wtb?](#why-wtb)
- [Philosophy & scope](#philosophy--scope)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Commands](#commands)
  - [`init`](#wtb-init)
  - [`create`](#wtb-create-branch)
  - [`remove`](#wtb-remove-branch)
  - [`reclone`](#wtb-reclone-branch)
  - [`prune`](#wtb-prune)
  - [`ls` / `list`](#wtb-ls-alias-list)
  - [`path`](#wtb-path-branch)
  - [`ports`](#wtb-ports-branch)
  - [`status`](#wtb-status)
  - [`init-claude`](#wtb-init-claude)
- [Configuration](#configuration)
- [Environment variable adjustment](#environment-variable-adjustment)
- [Docker Compose integration](#docker-compose-integration)
- [Volume cloning](#volume-cloning)
- [Lifecycle scripts](#lifecycle-scripts)
- [Architecture](#architecture)
- [Development](#development)
- [Design notes](#design-notes)
- [Requirements](#requirements)
- [Claude Code integration](#claude-code-integration)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [Changelog](#changelog)
- [License](#license)

## Why wtb?

Git worktrees are powerful but awkward on their own: every new working directory needs its gitignored files copied, dependencies installed, ports remapped, and long-lived services restarted. wtb automates that glue so each branch feels like a self-contained mini-environment.

Typical use cases:

- You're in the middle of a feature branch and an urgent hotfix lands — spin up a second working directory in seconds.
- You want several feature branches building, testing, or serving in parallel without port collisions.
- You need a clean checkout to review a PR without stashing, resetting, or killing your running dev server.
- You'd like `.env`, local configs, or credentials automatically copied (and adjusted) to each new worktree.
- You run Docker Compose and need each branch's services on their own ports.

## Philosophy & scope

wtb is built for a particular way of working: running many changes — including ones that touch the database and backend — in true parallel, one isolated worktree per change.

- **Parallelism is the speedup.** In vibe-coding workflows, doing DB- and backend-touching changes in full parallel (a worktree per change) is where the time savings come from.
- **Every worktree is fully autonomous on code.** Each worktree can change and run code on its own, completely independent of the others.
- **Every worktree is fully autonomous on data.** Each worktree starts from a complete copy of the DB state, so it can write migrations and mutate data freely without affecting any other worktree.
- **Conflicts are expected — and that's fine.** Working this way, conflicts are the norm; the best code emerges from the collision of competing requirements. wtb deliberately does *not* try to resolve them for you.
- **Docker Compose only, for now.** wtb currently supports Docker Compose plus its YAML and env files only. Other stacks are out of scope at this stage.
- **No coding-agent orchestration (yet).** wtb does not orchestrate coding agents. A coding agent launched inside a worktree should treat its job as done once it finishes the task; if more work is needed, a human is expected to go in and pick it up. In practice the recommended pattern is to let the agent run all the way to opening a pull request.
- _The author is partial to the V6 hybrid power units used in F1._

## How it works

```
project/                        ← main worktree (your original repo)
├── wtb.yaml
├── .env                        APP_PORT=3000
├── docker-compose.yml          3000:80
├── node_modules/
└── src/

worktree-feature-auth/          ← created by `wtb create feature/auth`
├── .env                        APP_PORT=3001   (auto-bumped, collision-free)
├── docker-compose.yml          3001:80         (auto-bumped)
├── node_modules -> ../project/node_modules     (symlinked, not copied)
└── src/                        (git worktree — shares the same .git)
```

When you run `wtb create <branch>`, the tool walks these phases in order:

1. **Worktree** — `git worktree add` at `../worktree-<sanitized-branch>/` (or a custom `-p <path>`), branching from `base_branch` unless the branch already exists (a branch that exists only on `origin` becomes a local tracking branch from `origin/<branch>`).
2. **Copy files** — `copy_files` (gitignored configs, secrets, etc.) are copied over. Paths also listed in `link_files` are skipped here.
3. **Symlink** — `link_files` entries are symlinked back to the source (existing files/dirs/symlinks are replaced safely).
4. **Environment files** — `env.file` entries are copied; if `env.adjust` is non-empty, port-style values are bumped to the next free port that doesn't collide with other worktrees' `.env` files.
5. **Docker Compose** — if `docker_compose_file` is configured, wtb reads it, remaps host ports around running containers, and writes the adjusted copy into the worktree.
6. **Volume clone** — every named (non-`external`) Docker volume declared in the Compose file is cloned to the new worktree's project, so e.g. PostgreSQL data carries over without re-seeding. If the source stack is running (the usual case for a live dev DB), wtb **automatically stops it, clones, and restarts it** so the copy is corruption-safe — no manual step. Pass `--no-stop` to skip in-use volumes instead, or `--force-volume-copy` to clone live. See [Volume cloning](#volume-cloning).
7. **Start command** — `start_command`, if configured, runs inside the new worktree with `/bin/sh`.

`wtb remove <branch>` runs in reverse: `docker compose down` (or `down -v` with `--remove-volumes`, unless `end_command` is set), then `end_command`, then `git worktree remove`.

## Quick start

### 1. Install

```bash
npm install -g @schemelisp/wtb
# or one-shot
npx @schemelisp/wtb create feature/awesome
```

### 2. Scaffold a config in your repo root

```bash
wtb init          # writes a commented wtb.yaml (base_branch detected from origin/HEAD)
```

Then edit the generated file. A minimal config looks like:

```yaml
# wtb.yaml
base_branch: main

copy_files:
  - .env
  - .env.local

link_files:
  - node_modules

env:
  file:
    - .env
  adjust:
    APP_PORT: 1       # auto-bump to the next free port
    DB_PORT: 1
```

### 3. Use it

```bash
wtb create feature/awesome
cd ../worktree-feature-awesome
# ...hack...
wtb remove feature/awesome
```

Preview without touching anything:

```bash
wtb create feature/awesome --dry-run
```

## Commands

### `wtb init`

Scaffolds a commented `wtb.yaml` at the repository root — the fastest way to get started. `base_branch` is detected from `origin/HEAD` (falls back to `main` when no remote default branch is set).

| Option | Description |
|--------|-------------|
| `-f, --force` | Overwrite an existing config file |

Fails with exit `1` if a config file already exists (use `--force` to overwrite it), and exit `3` outside a git repository.

### `wtb create <branch>`

Creates a new worktree for `<branch>`. Branch resolution, in order:

1. **Local branch exists** — it's used as-is.
2. **Branch exists only on `origin`** — wtb creates a local tracking branch (`git worktree add -b <branch> --track origin/<branch>`) instead of silently shadowing it with a new branch off `base_branch` (message: `ℹ️ Branch <branch> exists on origin — creating local tracking branch from origin/<branch>`).
3. **Brand-new branch** — created from `base_branch`. wtb first verifies that `base_branch` resolves (`git rev-parse --verify <base>^{commit}`, so tags/SHAs/remote refs are valid bases too) and fails with exit `1` and a hint to set `base_branch` in `wtb.yaml` if it doesn't (e.g. repos whose default branch is `master`).

If the branch's worktree already exists, `create` fails with exit `6` — pass `--exists-ok` to print its path and exit `0` instead (idempotent "ensure this worktree exists").

**Pipeline (short version):** worktree → copy → symlink → env → compose → start.

**Default path:** `../worktree-<branch-with-"/"-replaced-by-"-">`. Use `-p` to override.

| Option | Description |
|--------|-------------|
| `-p, --path <path>` | Custom worktree location |
| `--no-create-branch` | Use an existing branch (fails if it doesn't exist) |
| `--no-docker` | Skip Docker Compose copy/port-remap — **also skips volume cloning** (the volume phase requires Docker), so the worktree starts with empty volumes |
| `--no-env` | Skip `env.file` copy + `env.adjust` |
| `--no-copy` | Skip `copy_files` |
| `--no-link` | Skip `link_files` symlinks |
| `--no-start` | Skip `start_command` |
| `--no-volume-copy` | Skip cloning Docker volumes from the source project |
| `--force-volume-copy` | Clone volumes even when the source container is running or the target volume already has data |
| `--no-stop` | Don't auto-stop the source Compose stack before cloning; skip in-use volumes instead (the old behavior) |
| `--seed` | Seed the data instead of cloning: skip the volume-clone phase and run `volumes.seed_command` in the new worktree. Never touches the source volume, so the source stack is left running. Requires `volumes.seed_command` in the config; mutually exclusive with `--force-volume-copy`. See [Volume cloning](#volume-cloning) |
| `--strict` | Exit non-zero (`1`) if any volume clone or the seed command fails (default: exit `0` — the worktree still exists). For CI / coding-agent pipelines that must detect incomplete data isolation. See [Volume cloning](#volume-cloning) |
| `--exists-ok` | If a worktree for the branch already exists, print its path and exit `0` instead of failing with exit `6` |
| `--json` | Write exactly one machine-readable JSON object to stdout; human progress moves to stderr. See below |
| `--dry-run` | Print the plan, make no changes |

Examples:

```bash
wtb create feature/quick-fix --no-docker        # skip Docker even if configured
wtb create feature/wip --no-start               # skip install/setup
wtb create release/v2 --no-create-branch        # attach to an existing branch
wtb create feature/minimal \
  --no-docker --no-env --no-copy --no-link --no-start  # bare git worktree only
wtb create feature/test --dry-run               # preview
wtb create feature/auth -p /tmp/auth-wt         # custom path
```

In human mode, `create` echoes every adjustment it applied — per-key env bumps (`APP_PORT: 3000 → 3001`) under the env phase, per-service Compose remaps (`web: 3000 → 3001`) under the Compose phase — and the final *Next steps* block suggests `wtb ports --pretty` to review the worktree's assigned ports.

**JSON output (`--json`):** exactly one pretty-printed object on stdout; all human progress goes to stderr.

```json
{
  "branch": "feature/auth",
  "path": "/Users/me/worktree-feature-auth",
  "created": true,
  "existing": false,
  "createdBranch": true,
  "dryRun": false,
  "env": { "APP_PORT": { "from": "3000", "to": "3001" } },
  "composePorts": { "web": [{ "from": 3000, "to": 3001 }] },
  "volumes": { "cloned": ["db_data"], "skipped": [], "failed": [] },
  "seed": null,
  "startCommand": { "ran": true, "failed": false },
  "ok": true
}
```

- `volumes.skipped` entries are `{ name, reason }`; `volumes.failed` entries are `{ name, error }`. `seed` is `{ ran, failed }` when `--seed` was used, else `null`; same shape for `startCommand` when `start_command` is configured.
- `ok` is `false` when a volume clone or the seed command failed. `--strict --json` still exits `1` on such failures — the JSON is written first, then the exit code is set.
- With `--exists-ok` on an already-existing worktree the object is reduced to `{ branch, path, created: false, existing: true, createdBranch: false, dryRun, ok: true }`.

### `wtb remove <branch>`

Removes the worktree that owns `<branch>`. Guards against removing the main repository.

| Option | Description |
|--------|-------------|
| `-f, --force` | Skip the dirty-worktree pre-flight check and pass `--force` to `git worktree remove` (uncommitted changes are lost) |
| `--no-docker` | Skip `docker compose down` in the worktree |
| `--no-end` | Skip `end_command` |
| `--remove-volumes` | Also delete this worktree's Docker volumes (`docker compose down -v`). Has **no effect** (wtb warns) when teardown is skipped — i.e. with `--no-docker` or when `end_command` is set (your `end_command` must drop the volumes itself) |

Without `-f`, a worktree with uncommitted or untracked changes fails fast with exit `1` (`Worktree for '<branch>' has uncommitted or untracked changes; commit/stash them or pass -f to force removal`) — **before** any Docker teardown or volume deletion, so a doomed removal can't tear down services or drop volumes first.

Ordering: Docker teardown → `end_command` → `git worktree remove`. If `end_command` is set, wtb assumes you own teardown and skips the automatic `docker compose down`. The automatic teardown passes your configured Compose file explicitly (`docker compose -f <docker_compose_file> down [-v]`), so non-default filenames like `compose.dev.yml` are torn down correctly.

```bash
wtb remove feature/old --no-docker          # Docker daemon already stopped
wtb remove feature/abandoned -f --no-end    # force-remove, skip cleanup
```

### `wtb reclone [branch]`

Re-runs **only the volume-clone phase** for an existing worktree — useful when a clone previously failed or was skipped (empty/stale volumes) and you want to recover the data **without** removing and recreating the worktree (so uncommitted work is safe). Defaults to the current worktree; pass a branch to target another.

| Option | Description |
|--------|-------------|
| `--force-volume-copy` | Clone even when the source container is running or the target already has data (overwrite is atomic) |
| `--no-stop` | Don't auto-stop the source Compose stack; skip in-use volumes instead |
| `--strict` | Exit non-zero (`1`) if any volume fails to clone (default: exit `0`). For CI / coding-agent pipelines that must detect incomplete data isolation |
| `--json` | Write one machine-readable JSON object to stdout (`{ branch, path, dryRun, volumes: { cloned, skipped, failed }, ok }` — same per-volume shape as `create --json`); human progress moves to stderr |
| `--dry-run` | Print which volumes would be cloned; make no changes |

```bash
wtb reclone                       # current worktree
wtb reclone feature/auth          # a specific worktree
wtb reclone feature/auth --force-volume-copy   # overwrite stale target data
```

Prints the same `N cloned, N skipped, N failed` summary as `create`; a failure exits `0` with the loud `⚠️  … data is NOT fully isolated` line (resolve and re-run). With `--json`, `ok: false` flags the failure, and `--strict` still exits `1` after the JSON is written. Refuses to target the main repository worktree (source and target would be the same project). If `docker_compose_file` isn't configured, it's a no-op with a message. To re-*seed* instead of re-clone, run your `volumes.seed_command` inside the worktree.

### `wtb prune`

Removes **wtb-managed Docker volumes that are orphaned** — i.e., volumes wtb cloned for worktrees that no longer exist (because `wtb remove` leaves volumes by default) — plus **leftover temp volumes** from interrupted `--force-volume-copy` overwrites. Over many create/remove cycles these accumulate; `prune` is the cleanup. Only volumes labelled `wtb.managed=true` are ever touched, and a volume is removed only if it belongs to **no existing worktree** of this repo.

| Option | Description |
|--------|-------------|
| `-y, --yes` | Actually remove the volumes. **Without this, `prune` is a dry run** (lists candidates only) |
| `--json` | Machine-readable output: `{ dryRun, candidates, removed, failed }` — each candidate is `{ name, reason, inUse, inUseBy }`, where `inUseBy` lists the blocking container names; `removed`/`failed` are volume-name arrays |

```bash
wtb prune            # preview what would be removed (safe; deletes nothing)
wtb prune --yes      # remove the orphaned + leftover temp volumes
wtb prune --json     # machine-readable preview for scripts/agents
```

Safety: it's **dry-run by default** (deletion needs `--yes`); a volume currently in use by a container is skipped; and a worktree's volume is matched by its exact Compose project prefix (`<project>_…`), so it never removes a live worktree's data. Determines "live" worktrees from `git worktree list` for this repo.

With `--yes`, any volume-removal failure exits `5` (Docker error — treat it as a partial prune): without `--json` the error is `Error: Failed to remove N volume(s): <names>` on stderr; with `--json` the full JSON payload is still written to stdout (the failures listed in `failed`) and the exit code is set afterwards, so the JSON stays intact.

### `wtb ls` (alias: `list`)

Lightweight, scriptable listing of worktrees — like Unix `ls`. Use this instead of `status` when you just want to see what worktrees exist, without the Docker noise.

| Option | Description |
|--------|-------------|
| `-l, --long` | Long format: short hash, relative age, dirty flag, subject |
| `--json` | Machine-readable JSON (combines with `-l` for enriched fields) |
| `-p, --paths` | Absolute paths only, one per line — pipe-friendly |

Flags are prioritized, not combined: `-p` overrides `--json` and `-l` (paths-only output wins).

**Default (compact, 1 git call):**

```
→ main            /Users/me/proj                          [main]
  feature/api     /Users/me/proj-worktrees/feature-api
  feature/ui      /Users/me/proj-worktrees/feature-ui     [locked]
  hotfix/crash    /Users/me/proj-worktrees/hotfix-crash   [prunable]
  (detached)      /Users/me/proj-worktrees/detached-xyz
```

**Long (`-l`, extra `git log`/`git status` per worktree in parallel):**

```
  BRANCH          COMMIT   AGE        D  PATH                                   TAGS / SUBJECT
→ main            a1b2c3d  2h ago     *  /Users/me/proj                         [main] Add foo
  feature/api     9f8e7d6  3d ago        /Users/me/proj-worktrees/feature-api   WIP refactor
```

Legend:

- `→` in column 0 marks the worktree that contains your current working directory (works even in detached HEAD).
- Tags: `[main]` (main repository worktree), `[locked]` (`git worktree lock`), `[prunable]` (worktree directory gone), `[bare]` (bare repository).
- `D` column: `*` means the worktree has uncommitted changes.

**Paths-only for shell pipelines:**

```bash
cd "$(wtb ls -p | fzf)"                       # fuzzy-jump between worktrees
wtb ls -p | xargs -I{} du -sh {}              # disk usage per worktree
```

When you already know the branch, skip the interactive picker — [`wtb path`](#wtb-path-branch) resolves it deterministically: `cd "$(wtb path feature/x)"`.

**JSON:**

```bash
wtb ls --json | jq '.[] | select(.isMain == false) | .path'
wtb ls -l --json | jq '.[] | select(.dirty == true)'
```

JSON fields (always): `path, branch, head, isMain, isCurrent, locked, prunable, bare, detached`.
With `-l`: adds `shortHash, subject, ageRelative, ageTimestamp, dirty` — plus `enrichmentError` if per-worktree enrichment failed (e.g., prunable).

### `wtb path <branch>`

Prints the absolute path of the worktree that owns `<branch>` — one newline-terminated line, nothing else on stdout. The deterministic primitive for shell pipelines and coding agents:

```bash
cd "$(wtb path feature/x)"                    # jump straight to a worktree
wtcd() { cd "$(wtb path "$1")"; }             # handy shell function
```

If no worktree matches, it prints an `Available worktrees:` listing to stderr and exits `1` (stdout stays clean for pipelines). Exits `3` outside a git repository.

### `wtb ports [branch]`

Prints the adjusted `env.adjust` values, Docker Compose host/container ports, and a pre-rendered `http://localhost:<port>` endpoint list — for the current worktree, a specific branch's worktree, or all worktrees.

| Option | Description |
|--------|-------------|
| `-a, --all` | Output an array of every worktree's ports (default: current worktree as an object). Cannot be combined with a branch argument (exit `2`) |
| `--pretty` | Human-readable table instead of JSON |
| `--json` | Accepted as a no-op for consistency — JSON is already the default output. Conflicts with `--pretty` (exit `2`) |

```bash
wtb ports                  # current worktree
wtb ports feature/x        # a specific worktree by branch (no cd needed)
wtb ports -a               # every worktree, as a JSON array
```

An unknown branch prints an `Available worktrees:` listing to stderr and exits `1`.

Designed to be called from Claude Code (via the [shipped skill](#claude-code-integration)) or from shell scripts. See [Claude Code integration](#claude-code-integration) for the full output schema.

### `wtb status`

Richer inspection: worktrees + Docker Compose services + running containers + volumes. Slower than `ls` because it shells out to Docker.

| Option | Description |
|--------|-------------|
| `-a, --all` | Show all worktrees (default: current branch only) |
| `--docker-only` | Suppress worktree section, show only Docker info |
| `--json` | Machine-readable JSON (worktrees + Docker state) on stdout — for scripts/agents |

```
📁 Git Worktrees Status

→ main (main)
   📂 /Users/me/project
   🐳 Docker: docker-compose.yml
   📦 Services: 3
   🔧 Environment: .env, .env.local
```

`--json` returns one structured object (`{ worktrees: [...], docker: {...} }`) and stays valid JSON even when Docker is down (`docker.available: false`). Each `docker.volumes.wtb` entry carries a `labelled` boolean: `true` means the volume has the `wtb.managed=true` label (the source of truth); `false` means it was matched only by the legacy `wtb`/`worktree` name heuristic — check `labelled` before treating a volume as wtb-managed. Together with `wtb ls --json`, `wtb ports` (JSON by default), and `wtb create --json` / `wtb reclone --json`, every wtb read *and* mutation now has a machine-readable form.

```bash
wtb status --json | jq '.docker.containers[] | select(.isWtb) | .name'   # this project's containers
wtb status -a --json | jq '.worktrees[] | {branch, services: .compose.services}'
```

### `wtb init-claude`

Installs the bundled Claude Code skill into this repo (or globally). See [Claude Code integration](#claude-code-integration) for what the skill does.

| Option | Description |
|--------|-------------|
| `-f, --force` | Overwrite an existing `SKILL.md` |
| `--user` | Install at `~/.claude/skills/wtb/` instead of the repo |
| `--dry-run` | Print the target path; don't write |
| `--check` | Verify the installed `SKILL.md` against this CLI's version — exit `0` when up to date, `1` when it's missing, unstamped, or stale. Respects `--user`; writes nothing |

The installer stamps `SKILL.md` with `<!-- wtb-skill-version: X.Y.Z -->` right after the frontmatter. `--check` (and the skip message when the file already exists without `--force`) compares that stamp to the CLI version, so a stale skill is machine-detectable after upgrading wtb — refresh it with `wtb init-claude --force`.

## Configuration

wtb searches for a config file in this order and stops at the first match:

1. `wtb.yaml`
2. `wtb.yml`
3. `.wtb.yaml`
4. `.wtb.yml`
5. `.wtb/config.yaml`
6. `.wtb/config.yml`

If nothing is found, wtb still runs with defaults — it prints a warning to stderr spelling out what those defaults mean (`base_branch: main`, copy `./.env` unchanged, no port remapping) and suggests running [`wtb init`](#wtb-init) to scaffold a config. The config is **merged with defaults** — any field you omit gets the default.

### Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `base_branch` | string | `"main"` | Base branch used when creating a brand-new branch |
| `docker_compose_file` | string | `""` | Path (relative to config) to the Compose file. Empty/omitted → Docker skipped entirely |
| `copy_files` | string[] | `[]` | Files/dirs to copy to new worktrees (even if gitignored). Directories are copied recursively |
| `link_files` | string[] | `[]` | Files/dirs to symlink into the new worktree. Takes **priority** over `copy_files` on duplicates |
| `start_command` | string | — | Runs in the new worktree via `/bin/sh` after creation. Relative scripts are resolved against the worktree root |
| `end_command` | string | — | Runs in the worktree before removal. Setting this **suppresses** the automatic `docker compose down` |
| `env.file` | string[] | `["./.env"]` | Env files to copy into the worktree |
| `env.adjust` | map | `{}` | Per-key adjustment (see [Environment variable adjustment](#environment-variable-adjustment)) |
| `volumes.exclude` | string[] | `[]` | Compose volume keys to **exclude** from auto-cloning. Default: every named non-`external` volume in the Compose file is cloned. See [Volume cloning](#volume-cloning) |
| `volumes.seed_command` | string | — | Command run in the new worktree (via `/bin/sh`) when `wtb create --seed` is used, **instead of** cloning volume data. Lets a worktree start from a freshly seeded DB rather than a copy of main's. See [Volume cloning](#volume-cloning) |

### Validation

On load, wtb validates the config:

- **Errors** (fail with exit code `4`): wrong types, missing/invalid `base_branch`, non-array `copy_files`/`link_files`, invalid `env.adjust` value type.
- **Warnings** (stderr, keep running): referenced `docker_compose_file` / `env.file` not found on disk; an `env.adjust` key that isn't a valid POSIX env var name (it would never match a `.env` entry — wtb suggests a sanitized form).

### Annotated example

```yaml
# wtb.yaml — full example
base_branch: main
docker_compose_file: ./docker-compose.yml

# Copied into each new worktree even when gitignored
copy_files:
  - .env
  - .env.local
  - .secrets
  - config/

# Symlinked back to the source repo — avoid copying giant dirs
link_files:
  - node_modules
  - .cache
  - .next/cache

# Lifecycle scripts — run inside the worktree via /bin/sh
start_command: npm install && npm run db:migrate
end_command:   docker compose down -v

env:
  file:
    - .env
    - .env.local
  adjust:
    APP_PORT: 1          # any number → "auto-bump to the next free port"
    DB_PORT: 1
    API_KEY: "dev-key"   # string → literal replacement
    DEBUG_PORT: null     # null → remove the variable entirely
```

## Environment variable adjustment

`env.adjust` lets you rewrite values in every env file as it is copied. Three value types are supported:

| Value type | Behavior on existing key | Behavior when key is absent |
|------------|--------------------------|-----------------------------|
| **number** | Scans other worktrees + this file for the port values of every key listed as a number in `env.adjust` (so cross-key collisions between worktrees are avoided too), then picks the first free port starting at `original + 1`. The number literal itself is used as a type marker — any positive integer works. | **Nothing is added** — wtb prints a warning. A port adjustment needs an existing value to bump, so writing the marker integer (e.g. `PORT=1`) would be meaningless. Define the key in the file, or use a string value to add a literal. |
| **string** | Value is replaced verbatim. | Key is appended with the string value. |
| **null**   | Key is removed from the output. | No-op. |

Port collision sources considered:

1. Other worktrees' `.env` files (only for keys listed as numbers in `env.adjust`).
2. Other numeric entries in the current adjustment pass (so a single file doesn't collide with itself).

Key naming: only POSIX-compliant names (`^[A-Za-z_][A-Za-z0-9_]*$`) are recognized as adjustable variables. Lines whose key doesn't match are passed through untouched (they're treated as ordinary file content, not as keys to adjust).

## Docker Compose integration

When `docker_compose_file` is set and the file exists:

1. wtb reads it from the source repo.
2. Calls `docker ps` to collect ports already claimed by running containers.
3. For every `services.*.ports` mapping, the host port is rewritten to the first free port at/above the original, honoring the running-container set plus any ports already remapped in this pass.
4. Writes the adjusted Compose file into the worktree at the same relative path.

Notes:

- Port format recognized: `HOST:CONTAINER`, `0.0.0.0:HOST:CONTAINER`, optional `/tcp`/`/udp`.
- The **original** host port is tried first — if the base port is free, it's kept. (Env-file adjustment is stricter and always starts at `original + 1`.)
- The Compose copy is parsed and re-serialized — YAML comments, anchors, and original formatting are **not** preserved. This is true of every Compose file wtb writes.
- If Docker isn't installed or the daemon isn't running, wtb still parses and rewrites the Compose file, but with no running containers to avoid, the host ports keep their original values (a warning is printed) — your worktree still works, you just own port collisions.
- `wtb remove` runs `docker compose -f <your configured compose file> down` in the worktree before removing it (so non-default filenames like `compose.dev.yml` work), unless `end_command` is set (then you own teardown) or `--no-docker` is passed.
- Disable Compose integration entirely by omitting the field or setting it to `""`.

## Volume cloning

After remapping the Compose file, wtb **automatically clones every named Docker volume** declared in the Compose `volumes:` section from the source project to the new worktree's project. This is what makes a new worktree start with the same database/cache contents your main worktree already has — no manual `pg_dump | pg_restore` cycle, no re-seeding.

How it works:

1. wtb enumerates `volumes:` keys from the Compose file.
2. Volumes marked `external: true` are **skipped** (they're shared by design).
3. Source volume name is resolved as `<source_project>_<key>` (or the explicit `volumes.<key>.name` if set). Same for the target with the new worktree's project name.
4. **Stop-then-copy.** If any cloneable source volume is in use by a running container, wtb **stops the source Compose stack** (`docker compose stop` — containers/networks are preserved), clones, then **restarts it** (`docker compose start`). The restart runs in a `finally` block and is also wired to `SIGINT`, so an interrupted clone (Ctrl-C) never leaves your source services down. This makes a live dev DB clone safely with no manual step. Opt out with `--no-stop` (then in-use volumes are skipped with a warning instead), or use `--force-volume-copy` to clone live without stopping (data-corruption risk). Note: `docker compose start` brings up *every* stopped service in the project — if you had intentionally left some down, re-stop them after.
5. For each volume:
   - **If the source stack was stopped** (or `--force-volume-copy` was passed, or nothing was running), wtb clones it.
   - **If `--no-stop` is set and a running container is using the source volume**, wtb skips it with a warning (a live filesystem copy of an active database can corrupt — Postgres/MySQL/Redis). Stop the source side with `docker compose stop` first, drop `--no-stop`, or pass `--force-volume-copy`.
   - **If the target volume already has data**, wtb skips it (assumes you've already populated it). Pass `--force-volume-copy` to overwrite. The overwrite is **atomic**: wtb stages the new data into a temporary volume and verifies it before replacing the target, so a failed copy never leaves the target emptied.
   - Otherwise, wtb does a recursive copy via a transient `instrumentisto/rsync-ssh` sidecar container (with an Alpine `cp -a` fallback if rsync isn't available).

Every volume wtb creates is labelled **`wtb.managed=true`**, so it is self-identifying regardless of how the project/path is named. `wtb status` uses this label to report wtb-managed volumes accurately (even for custom `-p` paths), and you can list them yourself with `docker volume ls --filter label=wtb.managed=true`.

Selectively exclude volumes you don't want to clone (e.g. regenerable caches):

```yaml
# wtb.yaml
volumes:
  exclude:
    - cache_data
    - tmp_data
```

Disable the whole phase per-invocation with `wtb create <branch> --no-volume-copy`. Keep the source stack running and skip in-use volumes with `--no-stop`. Force-clone running source volumes live (data-loss risk, dev only) with `--force-volume-copy`.

The per-volume summary reports `N cloned, N skipped, N failed`. If any volume **fails** to clone, the worktree is still created but the final banner changes from `🎉 Worktree created successfully!` to `⚠️  Worktree created, but N volume(s) FAILED to clone — this worktree's data is NOT fully isolated`, so the incomplete state is obvious. By default the command still exits `0` (the worktree exists) — pass **`--strict`** to make a clone (or `--seed`) failure exit `1` instead, so CI and coding-agent pipelines can detect incomplete data isolation. A *skip* is intentional — missing source; in-use (under `--no-stop`, or even after stopping the source stack when another Compose project is holding the same named volume); or a target that already has data. External and `exclude`-listed volumes are filtered out before counting and never appear in the summary. A *failure* means the copy itself errored.

`wtb remove <branch>` does **not** delete cloned volumes by default (consistent with `docker compose down`). Pass `wtb remove <branch> --remove-volumes` to also drop them (`docker compose down -v`). Because that runs through the automatic teardown, `--remove-volumes` is a no-op (with a warning) when teardown is skipped — under `--no-docker`, or when `end_command` is set (then your `end_command` owns volume removal). Volumes left behind this way accumulate as orphans over time — sweep them with [`wtb prune`](#wtb-prune) (every wtb-created volume carries the `wtb.managed=true` label).

### Seed instead of clone (`--seed`)

Sometimes you don't want a copy of main's data — you want a **freshly seeded** database in the new worktree (a clean migration target, a deterministic test fixture, etc.). Configure a seed command and pass `--seed`:

```yaml
# wtb.yaml
volumes:
  seed_command: docker compose up -d db && npm run db:migrate && npm run db:seed
```

```bash
wtb create feature/clean-db --seed
```

With `--seed`, wtb **skips the volume-clone phase entirely** and runs `volumes.seed_command` in the new worktree (via `/bin/sh`, `cwd` = worktree root, same path-or-shell resolution as `start_command`). Because nothing is ever read off a live source volume, this path **never stops the source stack** — your main services keep running untouched. This is the "data-autonomous by construction" path: the worktree's data is built fresh, not copied.

Notes:

- `--seed` requires `volumes.seed_command` to be set; otherwise `create` fails with exit `4` before creating the worktree.
- `--seed` and `--force-volume-copy` are mutually exclusive (one seeds, the other clones) — passing both fails with exit `1`.
- If the seed command fails, the worktree is still created but the banner becomes `⚠️  Worktree created, but the seed command FAILED — this worktree's data is NOT ready` (exit stays `0`, same contract as a failed clone; pass `--strict` to exit `1` instead). Re-run the seed inside the worktree after fixing it.

## Lifecycle scripts

`start_command` and `end_command` run inside the worktree with `cwd` set to the worktree root and a `/bin/sh` shell. For `start_command`, wtb first tries resolving the string as a path relative to the worktree (so `./scripts/setup.sh` works); if the file doesn't exist it's passed to the shell as-is (so `npm install && npm run dev` also works).

Script failures are **non-fatal** — wtb prints a warning and the worktree is left in place so you can finish the setup manually.

## Architecture

```
src/
├── cli/
│   ├── commands/      init, create, remove, reclone, prune, ls, path, ports, status, init-claude
│   ├── utils/         worktree/ports renderers, command error wrapper, claude skill installer
│   └── index.ts       commander wiring + global error handlers
├── core/
│   ├── config/        YAML loader + validator + defaults merge
│   ├── git/           repository / worktree / commit-info helpers
│   ├── docker/        `docker ps`, compose parse/write, port adjust
│   └── environment/   .env parser (order-preserving) + adjust + serialize
├── utils/             safe exec helpers (execFileSync wrappers), errors
├── types/             all public types (WtbConfig, WorktreeInfo, …)
├── constants/         defaults, command templates, regex, exit codes
└── index.ts           library entry point
```

For full module-by-module API surface and design rationale, see [ARCHITECTURE.md](ARCHITECTURE.md).

Key design choices:

- **No shell-injection surface for git/docker.** Anything derived from user input (branch names, paths) is passed to `execFileSync` as array arguments, never interpolated into a shell string. A few fixed `docker compose` invocations use `execSync` with hardcoded constants only (no user input). The one place a shell is used intentionally is user-supplied lifecycle scripts, which run via `/bin/sh`.
- **Defaults-merge with `??`.** Missing fields fall back to defaults, but empty arrays/strings you explicitly set are preserved.
- **Order-preserving `.env` parsing.** Comments, blank lines, and inline `# comments` survive the copy + adjust round-trip.
- **Pure renderers for `ls`.** `renderDefault`/`renderLong`/`renderPaths`/`renderJson` are unit-tested in isolation; the command module just wires them up.
- **Enrichment is best-effort.** `ls -l` falls back gracefully on prunable/broken worktrees and still prints the rest — the failure is surfaced in JSON as `enrichmentError`.

Exit codes (`src/constants/index.ts`):

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | General error |
| `2` | Invalid CLI usage — missing argument, unknown option/command, invalid/excess arguments, and conflicting options (e.g. `wtb ports --json --pretty`, or a branch argument combined with `--all`). `--help`/`--version` still exit `0` |
| `3` | Not in a git repository |
| `4` | Configuration error (config not found-but-invalid, parse failure, or validation failure) |
| `5` | Docker error — currently emitted only by `wtb prune --yes` when one or more volume removals fail (a partial prune). Other Docker problems still degrade gracefully (warn + continue) or surface as `1` |
| `6` | Worktree already exists — `wtb create` for a branch that already has a worktree, without `--exists-ok` |
| `130` / `143` | Interrupted by SIGINT (Ctrl-C) / SIGTERM. Treat the run as aborted — an interrupted `create` may be partially done |

## Development

```bash
git clone https://github.com/origamium/wtb.git
cd wtb
npm install

npm run dev                    # run the CLI from source (tsx)
npm run build                  # tsc → dist/
npm start                      # run the built CLI

npm run test                   # vitest watch
npm run test:run               # vitest once
npm run test:unit              # unit tests (src/)
npm run test:e2e               # e2e (creates real git repos under test-repos/)
npm run test:integration       # real-Docker volume-clone checks (skips if Docker is absent)
npm run test:ui                # vitest UI

npm run typecheck              # tsc --noEmit
npm run lint                   # biome lint
npm run format                 # biome format --write
npm run check                  # biome check --write (lint + format)
```

E2E tests (`e2e/`) create temporary git repos and exercise the compiled CLI end-to-end. See `sample/` for a runnable playground — a tiny Next.js + Postgres stack with a real `wtb.yaml`, `.env`, and `docker-compose.yml`.

For a broader spread of configs — full-stack Compose, minimal Compose, seed/exclude/external volumes, a no-Docker Node project, and a bare-minimum setup — see [`examples/`](examples/). Each is a self-contained project, and `examples/try.sh <example> [branch] [--real]` drives the real CLI against any of them in a throwaway git repo (dry-run by default):

```bash
examples/try.sh                                   # list the examples
examples/try.sh minimal                           # preview the plan
examples/try.sh compose-minimal feature/db --real # real run (clones the DB volume)
```

## Design notes

- **Symlinks beat copies for large trees.** `node_modules`, `.cache`, `.next/cache` should almost always go in `link_files`. One source of truth, zero disk duplication, instant worktree creation. The tradeoff: native modules rebuilt for a different platform in one worktree affect all of them — use `copy_files` for those.
- **Branch name sanitization.** `/` in branch names becomes `-` in the default path: `feature/auth` → `worktree-feature-auth`. Use `-p <path>` if you need full control.
- **Docker is optional at every step.** Omit `docker_compose_file`, or install without Docker, or pass `--no-docker` — wtb degrades gracefully and only produces Docker-related output when Docker is reachable.
- **`wtb ls` vs `wtb status`.** `ls` is for fast, scriptable enumeration (1 git call in the default form). `status` is for human inspection with Docker context. Use `ls -l --json` in scripts.
- **Dry-run is honest.** `--dry-run` walks every phase and prints what it *would* do, including which files are missing and would be skipped.

## Requirements

- Node.js **≥ 18**
- Git (any modern version with `worktree` support)
- Docker + Docker Compose (optional — only if `docker_compose_file` is configured)

## Claude Code integration

wtb ships a [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) that teaches the agent how to inspect this repo's worktrees and call the CLI itself. Once installed, Claude can answer *"what port is this worktree on?"* or *"spin up a worktree for feature/auth"* without any hand-holding.

### Install once per repo

```bash
wtb init-claude                          # writes .claude/skills/wtb/SKILL.md
git add .claude/skills/wtb
git commit -m "chore: install wtb Claude Code skill"
```

Because `.claude/skills/` is a regular tracked directory, every worktree you create with `git worktree add` / `wtb create` automatically inherits the skill — there is nothing to sync per-worktree.

Prefer a global install?

```bash
wtb init-claude --user                   # writes ~/.claude/skills/wtb/SKILL.md
```

Flags: `-f, --force` (overwrite existing), `--user` (global), `--dry-run` (preview target path only), `--check` (verify the installed skill against the CLI version; writes nothing).

The installed `SKILL.md` is stamped with `<!-- wtb-skill-version: X.Y.Z -->`, so after upgrading wtb you can run `wtb init-claude --check` (exit `0` when current, `1` when missing/unstamped/stale) and refresh with `wtb init-claude --force`.

### `wtb ports` — the data source

The skill tells Claude to call `wtb ports` (JSON is the default output — `--json` is accepted as a no-op and conflicts with `--pretty`). The command is useful on its own too:

```bash
wtb ports                                # current worktree as a JSON object
wtb ports feature/auth                   # a specific worktree by branch
wtb ports -a                             # every worktree as a JSON array (alias: --all)
wtb ports --pretty                       # human-readable
```

Output shape:

```json
{
  "path": "/Users/me/worktree-feature-auth",
  "branch": "feature/auth",
  "env": { "APP_PORT": "3001", "DB_PORT": "5433" },
  "compose": {
    "file": "docker-compose.yml",
    "services": {
      "web": { "host_ports": [3001], "container_ports": [80] },
      "db":  { "host_ports": [5433], "container_ports": [5432] }
    }
  },
  "endpoints": ["http://localhost:3001", "http://localhost:5433"]
}
```

Notes:

- `env` only contains keys listed under `env.adjust` in `wtb.yaml` — other `.env` entries (secrets, API keys) are **not leaked**.
- `compose.services` is populated from the worktree's copy of the Compose file, so it reflects the *already-adjusted* ports.
- `endpoints` is a convenience list of `http://localhost:<port>` entries built from compose host ports.
- `wtb ports` reads the Compose YAML from disk and never calls Docker, so output is identical whether or not Docker is installed. `compose.services` is `{}` only when no compose file is found or it can't be parsed (warning on stderr); stdout always stays valid JSON.

### What Claude sees

With the skill installed, typical prompts just work:

| You say | Claude does |
|---------|-------------|
| "What port is the API on here?" | `wtb ports` → picks the right host port (JSON by default) |
| "List the worktrees." | `wtb ls -l` |
| "Go to the worktree for feature/x." | `cd "$(wtb path feature/x)"` — deterministic branch → path lookup |
| "Set up wtb in this repo." | `wtb init` → scaffolds a commented `wtb.yaml` |
| "Make a worktree for feature/login." | `wtb create feature/login` (prompts you first if destructive) |
| "Clean up feature/old." | `wtb ls -l` to show the target → confirms → `wtb remove feature/old` |
| "This worktree's DB is empty / the clone failed." | `wtb reclone` → re-runs just the volume-clone phase, no worktree recreation |
| "What's actually running for this worktree?" | `wtb status --json` → live containers/volumes as structured data |

The skill's `description` triggers automatically when `wtb.yaml` is in the repo, so you usually don't need to invoke it by hand.

## Troubleshooting

### "Not in a git repository" (exit 3)
Run wtb from anywhere inside your repo. It discovers the git root via `git rev-parse --show-toplevel`.

### Ports still collide
wtb adjusts against *known* sources:

- For `.env` files: other worktrees' `.env` files, for any key listed as a number in `env.adjust` (not just the same key).
- For Docker Compose: currently running containers and the ports it remapped earlier in the same pass.

It does **not** probe arbitrary OS-level listening sockets. If something outside Docker is holding a port (a native dev server you started by hand, another project on the same machine, etc.), you'll need to stop it or edit `env.adjust` manually. Check `wtb status -a` to see what wtb thinks is going on.

### "Worktree for branch 'X' already exists" (exit 6)
The branch already has a worktree. `wtb ls` shows where it is. `wtb remove X` cleans it up first — or pass `--exists-ok` to `wtb create` if reusing it is fine (prints the path, exits `0`).

### `git worktree add` fails with "invalid reference"
The branch doesn't exist and you passed `--no-create-branch`. Drop that flag to create it, or check your branch name.

### Config validation failed (exit 4)
The config is structurally invalid — the error lists each bad field. Warnings about missing `docker_compose_file` / `env.file` paths are non-fatal and go to stderr.

### `start_command` failed
wtb leaves the worktree in place and prints a warning. Finish setup manually in the worktree, then proceed.

### Docker daemon stopped mid-session
`docker compose down` on `remove` fails silently with a warning; the worktree still gets removed. On `create`, the Compose file is still parsed and rewritten, but with no running containers to avoid, host ports keep their original values. Note that YAML comments, anchors, and formatting are not preserved — this is true of every Compose copy wtb writes.

## FAQ

**Is this different from `git worktree add`?**
wtb *uses* `git worktree add` under the hood, then layers on the environment-sync logic that git itself doesn't handle: gitignored config files, symlinks, env-var remapping, Compose port adjustment, and lifecycle scripts.

**Do I have to use Docker?**
No. Leave `docker_compose_file` empty (or omit it) and the Docker phases are skipped entirely. Everything else — copy, symlink, env adjust, lifecycle scripts — still works.

**What happens to my `.git` directory?**
Untouched. Every worktree shares the same `.git` via Git's native worktree mechanism; disk usage stays flat.

**Can I use this in CI?**
Yes — but lifecycle scripts, Docker integration, and port remapping are mostly useful on a dev box. In CI, `wtb create <branch> --no-docker --no-start --no-link` gives you a clean isolated checkout fast.

**Why the "wtb" name?**
Short for "worktree turbo" — git worktrees, but with the environment-wrangling turbocharged.

## Roadmap

Planned, **not yet implemented** — listed so the intended direction is on record.

- _Nothing currently on the list — the previously-planned items have shipped (see below). Open an issue with what you'd like to see next._

Recently shipped (was on this list):

- **Seed instead of copy (opt-in).** ✅ `wtb create --seed` runs `volumes.seed_command` in the new worktree instead of cloning volume data — for a freshly seeded DB rather than a clone of main's. Because nothing is copied off a live volume, this path does *not* stop the source stack. See [Volume cloning → Seed instead of clone](#seed-instead-of-clone---seed).
- **Stop-then-copy for DB integrity.** ✅ `create` now auto-stops the source Compose stack before cloning live volumes and restarts it afterward (crash-safe), so a running dev DB clones with no manual step. Opt out with `--no-stop`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

[MIT](LICENSE) © ONOUE Origami
