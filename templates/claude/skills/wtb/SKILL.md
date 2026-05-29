---
name: wtb
description: Use this skill when working in a repository that contains a wtb.yaml or .wtb.yaml config. wtb is a CLI that manages multiple git worktrees with per-worktree environment and port isolation. Activate this skill when the user asks about - this worktree's local ports, endpoints, or URLs; which worktrees exist or which is main/current; creating, removing, or listing worktrees for a branch; why a dev server or Docker Compose service is reachable on a non-default port; setting up a new feature branch environment. The skill explains how to invoke the wtb CLI via Bash and how to interpret its JSON output.
---

# wtb skill

wtb gives every git branch its own isolated working directory with remapped ports and copied `.env` files. Each worktree's concrete port numbers are only discoverable at runtime — that is what this skill is for.

## When to use

Activate this skill when the user says or implies any of:

- "What port is this worktree on?" / "What URL do I hit for the API?" / "What's the DB port here?"
- "List / show the worktrees." / "What worktrees do we have?" / "Which branch is main?"
- "Make a worktree for feature/X" / "Spin up a branch environment for bugfix/Y."
- "Tear down / remove / clean up the worktree for feature/X."
- "Why is the service on port 3002 not 3000?" — wtb auto-bumps ports to avoid collisions.
- Any time the user wants to hit a local URL and you do not already know the port.

Also activate when `wtb.yaml`, `.wtb.yaml`, `.wtb.yml`, or `.wtb/config.yaml` exists at the repo root, even without an explicit trigger — that config is the sign wtb is in use.

## Which command to run

| User intent | Command | Why |
|---|---|---|
| "What port is X on?" | `wtb ports` | JSON by default, includes endpoints |
| "What worktrees exist?" | `wtb ls --json` | Fastest structured listing (1 git call) |
| "Show me everything (incl. Docker state)" | `wtb status -a` | Human-readable, includes containers/volumes |
| "Make a worktree" | `wtb create <branch>` | Always preview with `--dry-run` first if config is unfamiliar |
| "Remove a worktree" | `wtb remove <branch>` | **Destructive** — confirm with the user first |

Read-only commands (`ls`, `ports`, `status`) are safe to run autonomously. Mutating commands (`create`, `remove`) require explicit user intent.

## Discovering the current worktree's endpoints

Run `wtb ports` from anywhere inside the worktree and parse the JSON. **Do this before hitting any local service when the port is not obvious.** JSON is the default output — there is no `--json` flag.

```bash
wtb ports                # current worktree, JSON object
wtb ports --all          # every worktree, JSON array
wtb ports --pretty       # human-readable table (use only when displaying to user)
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

Reading the output:

- `env` only contains keys the user listed under `env.adjust` in `wtb.yaml` — it will not leak arbitrary `.env` secrets.
- `compose.services.<service>.host_ports[]` is the authoritative list of host-bound ports (already adjusted for the current worktree).
- `endpoints` is a pre-rendered list of `http://localhost:<host_port>` entries. Use these first; reach for `env.*_PORT` only if no compose file is present.
- If Docker is missing or the Compose file is absent, `compose.services` is `{}` — that is not an error. Use `env` values instead.
- Warnings (e.g. `📋 Loading configuration from: wtb.yaml`) go to stderr; stdout stays valid JSON. Pipe to `jq` safely.

When the user asks an open question like "check the health endpoint," pick the first `http://localhost:<port>` from `endpoints` (or reason from service names like `web` / `api` when multiple exist).

## Listing worktrees

```bash
wtb ls              # compact, marker for current worktree
wtb ls -l           # enriched: short hash, age, dirty flag, subject (parallel git calls)
wtb ls --json       # machine-readable; combines with -l for enrichment fields
wtb ls -p           # absolute paths only, one per line — pipe-friendly
```

JSON fields (always): `path, branch, head, isMain, isCurrent, locked, prunable, bare, detached`.
With `-l` adds: `shortHash, subject, ageRelative, ageTimestamp, dirty` (and `enrichmentError` if a worktree was unreadable).

Common idioms:

```bash
wtb ls --json | jq '.[] | select(.isCurrent == true)'        # current worktree
wtb ls -l --json | jq '.[] | select(.dirty == true) | .path' # dirty worktrees only
cd "$(wtb ls -p | fzf)"                                        # fuzzy-jump
```

## Creating a worktree

```bash
wtb create feature/my-new-feature
```

Phases (in order): `git worktree add` → copy gitignored files → create symlinks → copy-and-adjust `.env` → rewrite Compose ports → **clone Docker named volumes** → run `start_command`.

The volume-clone step is automatic when `docker_compose_file` is set: every named (non-`external`) Docker volume is copied from the source project to the new worktree's project, so e.g. PostgreSQL data carries over. **If the source stack is running, wtb automatically stops it, clones, then restarts it** (`docker compose stop` → copy → `docker compose start`). The restart is guaranteed by a `finally` block, so even if the copy fails partway the source services are brought back up — they're never left down. This is what makes a worktree *data-autonomous* with no manual step: the new worktree starts from a full copy of the DB.

Useful flags:

- `--dry-run` — preview without touching anything. **Suggest this to the user before the real run** if the config is unfamiliar or recently changed.
- `-p <path>` — custom worktree location (default: `../worktree-<branch-with-slashes-as-dashes>`).
- `--no-create-branch` — attach to an existing branch instead of creating a new one.
- `--no-docker` / `--no-env` / `--no-copy` / `--no-link` / `--no-start` — skip individual phases.
- `--no-volume-copy` — skip the volume-clone phase entirely (start with empty volumes).
- `--no-stop` — don't auto-stop the source Compose stack; skip in-use volumes with a warning instead (the pre-stop-then-copy behavior). Use only when momentarily stopping the source services is unacceptable.
- `--force-volume-copy` — clone even when source containers are running or the target already has data (clones *live* without stopping — data-corruption risk; dev only). Overwriting an existing target is atomic (staged via a temp volume, verified, then swapped), so a failed overwrite never empties the target.
- `--seed` — **seed instead of clone.** Skips the volume-clone phase and runs `volumes.seed_command` in the new worktree instead, so the worktree starts from a *freshly seeded* DB rather than a copy of main's. Never reads the source volume, so the source stack is left running (no stop/restart). Requires `volumes.seed_command` in `wtb.yaml` (else exits `4` before creating the worktree); mutually exclusive with `--force-volume-copy` (passing both exits `1`). If the seed command fails the worktree is still created but the banner is `⚠️  Worktree created, but the seed command FAILED — this worktree's data is NOT ready` (exit `0`) — same not-ready contract as a failed clone.

After creation, the new worktree path is printed at the end. `cd` there, then re-run `wtb ports` to see the *new* worktree's adjusted ports.

### Recovering a skipped/empty volume clone

There is **no standalone re-clone subcommand** — volume cloning only happens during `create`. Two distinct signals matter, and `create` keeps the worktree either way:

- **Failure** — if a clone errors, the per-volume line is `❌ Failed to clone …`, the summary shows `… N failed`, and the final banner is **`⚠️  Worktree created, but N volume(s) FAILED to clone — this worktree's data is NOT fully isolated`** (instead of the `🎉` success banner). Treat this as data-not-ready: surface it, don't proceed as if clean.
- **Skip** — an intentional skip (`source volume … does not exist`, `is in use by …`, or `target … already has data`) means the volume was deliberately not copied; the worktree's DB volume is empty or stale.

To recover from either:

- **Default runs no longer skip just because the source is running** — wtb stops/restarts it automatically. On a default run a skip means one of: `--no-stop` was used; the source stack couldn't be stopped (e.g. Docker daemon error — look for "Could not stop source stack"); the volume is *still* in use after stopping (a shared, explicitly-`name:`d volume held by another Compose project); the target already had data; or the source volume didn't exist yet. The exact reason is printed on the skip line.
- If skipped due to `--no-stop` + a running source: `docker compose stop` the source stack, then re-run the clone by removing and recreating the worktree (`wtb remove <branch>` → `wtb create <branch>`), or copy the volume manually with `docker run --rm -v <src>:/from -v <dst>:/to alpine cp -a /from/. /to/`.
- If skipped because the target already had data: pass `--force-volume-copy` on a recreate to overwrite.
- If a `--force-volume-copy` overwrite **fails mid-commit** (rare: e.g. disk full while replacing the target), wtb keeps the verified copy in a temp volume (`<target>__wtbtmp_*`) and prints an exact `docker run … && docker volume rm …` recovery command — run it to finish restoring the target. Don't delete that temp volume until the target is restored.
- Confirm the data landed with `wtb status` (shows volumes) or `docker compose ps` in the worktree.

Note: the auto-restart runs `docker compose start` on the whole source project, so any service that was stopped before wtb ran is brought back up too. If you had deliberately left some services down, re-stop them after the clone.

## Removing a worktree (destructive — confirm first)

```bash
wtb remove feature/old-branch
```

**This is destructive.** Always:

1. Run `wtb ls -l` first to show the user what will be removed (path, dirty status, age).
2. Ask the user to confirm before executing `wtb remove`.
3. Only use `-f` / `--force` when the user explicitly acknowledges the uncommitted-change risk.

Flags:

- `-f, --force` — allow removal with uncommitted changes.
- `--no-docker` — skip `docker compose down` (useful when the Docker daemon is already stopped).
- `--no-end` — skip `end_command`.
- `--remove-volumes` — also delete the worktree's Docker volumes (`docker compose down -v`). **Destructive for cloned data — confirm with the user.**

Ordering is: Docker teardown → `end_command` → `git worktree remove`. Setting `end_command` in `wtb.yaml` suppresses the automatic Docker teardown (the user owns shutdown). The default leaves volumes intact (consistent with `docker compose down`); use `--remove-volumes` only if the user explicitly wants the data gone.

## Inspecting state

```bash
wtb status              # current branch + Docker state (human-readable)
wtb status -a           # all worktrees
wtb status --docker-only # skip the worktree section
```

Use `wtb status` for diagnosis when ports look wrong or services are missing — it shells out to `docker ps` and `docker volume ls` to show what is actually running. There is no JSON mode; for scripting use `wtb ls --json` and `wtb ports --all`.

## Config quick reference

`wtb.yaml` (or `.wtb.yaml` / `.wtb/config.yaml`) at the repo root. Read it when the user asks "what does wtb do on create?" or when their request hinges on what is configured.

| Field | Purpose |
|-------|---------|
| `base_branch` | Branch new worktrees fork from (default `main`). |
| `docker_compose_file` | Compose file to copy + port-remap. Empty/omitted = Docker skipped. |
| `copy_files` | Files/dirs copied into each worktree (e.g. `.env`). |
| `link_files` | Files/dirs symlinked (e.g. `node_modules`) — priority over `copy_files`. |
| `start_command` / `end_command` | Lifecycle scripts run via `/bin/sh` in the worktree. |
| `env.file` | Env files processed per worktree. |
| `env.adjust` | Per-key transform: `number` = auto-bump to next free port, `string` = literal replace, `null` = remove. |
| `volumes.exclude` | Compose volume keys to exclude from auto-cloning. Default `[]` (clone every named non-`external` volume). |
| `volumes.seed_command` | Command run in the worktree when `create --seed` is used, *instead of* cloning volume data (fresh-seeded DB rather than a copy of main's). |

## Troubleshooting hints

- "Port still collides" → wtb only scans other worktrees' `.env` files and running Docker containers. Anything else listening on the port is invisible to it. Check with `lsof -i :<port>` and stop the offender.
- "Not in a git repository" (exit 3) → run from inside the repo.
- "Worktree for branch 'X' already exists" → `wtb ls` shows where; `wtb remove X` to clear.
- Docker daemon down → `wtb ports` still works, `compose.services` will be `{}`. `wtb remove` skips teardown gracefully.
- Config validation error (exit 4) → fields like `base_branch` missing or wrong type. The error message names the bad field.

## Conventions

- All read-only commands (`ls`, `ports`, `status`) are safe to run without confirmation. `create` and `remove` mutate state — confirm first.
- `wtb ports` and `wtb ls --json` produce **valid JSON on stdout even when Docker is unavailable**. For these JSON read-commands, warnings/progress go to stderr, so `2>/dev/null` keeps pipes clean. (`create`/`remove` print human-readable output — including the volume-clone banner and `❌`/`⚠️` lines — to **stdout**; don't `2>/dev/null` those expecting to hide them.)
- Exit codes: `0` success, `1` general error, `2` usage, `3` not-a-git-repo, `4` config error (invalid/unparseable `wtb.yaml`). Code `5` (Docker error) is **reserved and not currently emitted** — Docker is optional and degrades gracefully, so Docker trouble either just warns (command still succeeds) or surfaces as `1`. **Caveat:** `wtb create` exits `0` even when a volume clone *failed* OR a `--seed` seed command *failed* (the worktree is still created). Do **not** gate data-readiness on `$?` alone — detect the `⚠️  Worktree created, but N volume(s) FAILED to clone` / `⚠️  Worktree created, but the seed command FAILED … data is NOT ready` banner on stdout (see [Recovering a skipped/empty volume clone](#recovering-a-skippedempty-volume-clone)).
- `wtb --help` and `wtb <command> --help` are always available for live reference.
