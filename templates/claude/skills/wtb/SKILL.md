---
name: wtb
description: Use this skill when working in a repository that contains a wtb config (wtb.yaml, wtb.yml, .wtb.yaml, .wtb.yml, .wtb/config.yaml, or .wtb/config.yml). wtb is a CLI that manages multiple git worktrees with per-worktree environment, port isolation, and Docker volume/database cloning. Activate this skill when the user asks about - this worktree's local ports, endpoints, or URLs; which worktrees exist or which is main/current; creating, removing, or listing worktrees for a branch; why a dev server or Docker Compose service is reachable on a non-default port; setting up a new feature branch environment; this worktree's database/volume being empty or its data not carrying over from main; cloning, re-cloning, recovering, or seeding a worktree's Docker volumes (e.g. PostgreSQL data); a failed or skipped volume clone; or inspecting Docker/container state per worktree. The skill explains how to invoke the wtb CLI via Bash and how to interpret its JSON output.
---

# wtb skill

wtb gives every git branch its own isolated working directory with remapped ports and copied `.env` files. Each worktree's concrete port numbers are only discoverable at runtime — that is what this skill is for.

## Operating model (how to think about worktrees)

This is the mental model that makes autonomous work in a worktree safe — internalize it before acting:

- **Each worktree is a fully self-contained mini-environment for one branch:** its own working dir (sharing the same `.git`), its own collision-free ports, its own copied `.env`, and its own **cloned copy of the DB/Docker-volume data** (or a freshly seeded DB with `--seed`). It is independent of every other worktree.
- **You can build, run, migrate, and mutate data freely inside it** without affecting `main` or any sibling worktree — the data is a full copy (or fresh seed), not shared. This is the point: parallel, DB-touching changes run in true isolation.
- **Conflicts between worktrees are expected and fine.** wtb deliberately does not resolve them; don't try to reconcile sibling worktrees.
- **Scope:** wtb covers Docker Compose stacks only. No coding-agent orchestration is built in.
- **When you (an agent) are working inside a worktree, treat the task as done once you've finished it** — the recommended pattern is to run all the way to opening a pull request. If more work is needed afterward, a human picks it up; don't spin up or manage other worktrees unless asked.

## When to use

Activate this skill when the user says or implies any of:

- "What port is this worktree on?" / "What URL do I hit for the API?" / "What's the DB port here?"
- "List / show the worktrees." / "What worktrees do we have?" / "Which branch is main?"
- "Make a worktree for feature/X" / "Spin up a branch environment for bugfix/Y."
- "Tear down / remove / clean up the worktree for feature/X."
- "Why is the service on port 3002 not 3000?" — wtb auto-bumps ports to avoid collisions.
- Any time the user wants to hit a local URL and you do not already know the port.
- "This worktree's database / volume is empty" / "the data didn't carry over from main" / "the volume clone failed or was skipped." → re-clone the data (`wtb reclone`).
- "Clone / copy / re-clone / recover the DB (PostgreSQL/MySQL/Redis) data into this worktree" or "seed a fresh DB for this worktree" (`wtb create --seed` / `volumes.seed_command`).
- "What containers/volumes is this worktree running?" / inspecting per-worktree Docker state programmatically (`wtb status --json`).

Also activate when `wtb.yaml`, `wtb.yml`, `.wtb.yaml`, `.wtb.yml`, `.wtb/config.yaml`, or `.wtb/config.yml` exists at the repo root, even without an explicit trigger — that config is the sign wtb is in use.

## Which command to run

| User intent | Command | Why |
|---|---|---|
| "What port is X on?" | `wtb ports` | JSON by default, includes endpoints |
| "What worktrees exist?" | `wtb ls --json` | Fastest structured listing (1 git call) |
| "cd into the worktree for X" | `cd "$(wtb path X)"` | Prints the absolute path, one line, nothing else on stdout |
| "Set up wtb in this repo" | `wtb init` | Scaffolds a commented `wtb.yaml` (refuses to overwrite without `--force`) |
| "Show me everything (incl. Docker state)" | `wtb status -a` | Human-readable, includes containers/volumes |
| "Make a worktree" | `wtb create <branch>` | Always preview with `--dry-run` first if config is unfamiliar |
| "Remove a worktree" | `wtb remove <branch>` | **Destructive** — confirm with the user first |
| "Its DB/volumes are empty or the clone failed" | `wtb reclone [branch]` | Re-runs just the volume-clone phase; recovers data without recreating the worktree |
| "Clean up leftover/orphaned volumes" | `wtb prune` (preview) → `wtb prune --yes` | Removes wtb-managed volumes from deleted worktrees + leftover temp volumes |
| "Why do two worktrees collide?" / "Is this compose worktree-safe?" | `wtb doctor` | Static preflight (no Docker) for worktree-relocatability problems before creating a worktree |

Read-only commands (`ls`, `path`, `ports`, `status`, `doctor`, and `wtb prune` without `--yes`) are safe to run autonomously. Mutating commands (`create`, `remove`, `reclone`, `prune --yes`) require explicit user intent.

## Discovering the current worktree's endpoints

Run `wtb ports` from anywhere inside the worktree and parse the JSON. **Do this before hitting any local service when the port is not obvious.** JSON is the default output (`--json` is accepted as a no-op for consistency; it conflicts with `--pretty`).

```bash
wtb ports                # current worktree, JSON object
wtb ports feature/auth   # a specific worktree by branch, JSON object (no cd needed)
wtb ports -a             # every worktree, JSON array (alias: --all; cannot combine with a branch)
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
- `wtb ports` reads the Compose YAML from disk and never calls Docker, so Docker being absent/down does not change its output. `compose.services` is `{}` only when no compose file is found or it can't be parsed — that is not an error. Use `env` values instead.
- `wtb ports` **resolves `${VAR}` / `${VAR:-default}` references** in compose port mappings statically against the worktree's env files (e.g. `'${KONG_HTTP_PORT:-54321}:8000'` resolves to a real host port). Precedence: worktree env-file value > compose default > unresolved (skipped, with a stderr warning naming the variable). Nested defaults `${A:-${B}}`, port ranges, and IPv6 are not resolved.
- `compose.file` is resolved per worktree: wtb prefers **this worktree's own copy** of `docker_compose_file` (so the ports are the *adjusted* ones) and only falls back to the source repo's copy if the worktree has none. If you see the source's path in `compose.file`, the worktree copy was missing and the ports may be the *un-adjusted* originals — re-run `wtb create` (or copy the compose file in) to get isolated ports.
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
wtb create feature/my-new-feature                  # human run: progress on stdout
wtb create feature/my-new-feature --json --strict  # agent run: one JSON object on stdout, exit 1 if data not ready
```

Phases (in order): `git worktree add` → copy gitignored files → create symlinks → copy-and-adjust `.env` → rewrite Compose ports + **per-worktree Compose identity** → **clone Docker named volumes** → run `start_command`.

The Compose rewrite is **on by default**: wtb rewrites the worktree's compose copy so the stack isolates per worktree — top-level project `name:` → `<original>-<branch-slug>` (`compose.isolate_name`) and each `container_name:` per `compose.container_name`. This fixes stacks with a fixed `name:`/`container_name:` (e.g. Supabase CLI output) that would otherwise collide across worktrees. With port propagation on, embedded ports (`${VAR:-default}` defaults, URLs in env values) follow the bump too.

**skip-worktree:** wtb marks the rewritten files that are git-tracked (the worktree's compose copy and adjusted/propagated env files) as git `skip-worktree`, so the per-worktree edits stay out of `git status`, don't block `wtb remove`, and aren't accidentally committed back to the branch. If the user genuinely wants to commit an edit to such a file in a worktree, run `git update-index --no-skip-worktree <file>` first.

Branch resolution: an existing local branch is used as-is; a branch that exists only on `origin` becomes a local tracking branch from `origin/<branch>` (not a new branch off `base_branch`); otherwise a new branch is created from `base_branch`, which wtb pre-verifies resolves (tags/SHAs/remote refs are valid bases) — exit `1` with a hint to set `base_branch` in `wtb.yaml` if it doesn't.

The volume-clone step is automatic when `docker_compose_file` is set: every named (non-`external`) Docker volume is copied from the source project to the new worktree's project, so e.g. PostgreSQL data carries over. **If the source stack is running, wtb automatically stops it, clones, then restarts it** (`docker compose stop` → copy → `docker compose start`). The restart is guaranteed by a `finally` block, so even if the copy fails partway the source services are brought back up — they're never left down. This is what makes a worktree *data-autonomous* with no manual step: the new worktree starts from a full copy of the DB.

Useful flags:

- `--dry-run` — preview without touching anything. **Suggest this to the user before the real run** if the config is unfamiliar or recently changed.
- `-p <path>` — custom worktree location (default: `../worktree-<branch-with-slashes-as-dashes>`).
- `--no-create-branch` — attach to an existing branch instead of creating a new one.
- `--no-docker` / `--no-env` / `--no-copy` / `--no-link` / `--no-start` — skip individual phases. Note: `--no-docker` skips **both** the Compose port-remap **and** the volume-clone phase (volume cloning is gated on Docker being active), so a worktree created with `--no-docker` starts with empty volumes even without `--no-volume-copy`.
- `--no-volume-copy` — skip the volume-clone phase entirely (start with empty volumes).
- `--no-stop` — don't auto-stop the source Compose stack; skip in-use volumes with a warning instead (the pre-stop-then-copy behavior). Use only when momentarily stopping the source services is unacceptable.
- `--force-volume-copy` — clone even when source containers are running or the target already has data (clones *live* without stopping — data-corruption risk; dev only). Overwriting an existing target is atomic (staged via a temp volume, verified, then swapped), so a failed overwrite never empties the target.
- `--seed` — **seed instead of clone.** Skips the volume-clone phase and runs `volumes.seed_command` in the new worktree instead, so the worktree starts from a *freshly seeded* DB rather than a copy of main's. Never reads the source volume, so the source stack is left running (no stop/restart). Requires `volumes.seed_command` in `wtb.yaml` (else exits `4` before creating the worktree); mutually exclusive with `--force-volume-copy` (passing both exits `1`). If the seed command fails the worktree is still created but the banner is `⚠️  Worktree created, but the seed command FAILED — this worktree's data is NOT ready` (exit `0`, or `1` with `--strict`) — same not-ready contract as a failed clone.
- `--strict` — exit `1` (instead of `0`) when any volume clone or the `--seed` command fails. Prefer this in scripted/agent runs so `$?` alone is a reliable data-readiness signal.
- `--exists-ok` — if a worktree for the branch already exists, print its path and exit `0` instead of failing with exit `6`. Use for idempotent "ensure this worktree exists" runs.
- `--json` — write exactly one machine-readable JSON object to stdout (human progress goes to stderr). Fields: `branch`, `path`, `created`, `existing`, `createdBranch`, `dryRun`, `env` (adjusted keys), `composePorts` (per-service `{from,to}` remaps), `volumes` (`cloned[]` / `skipped[{name,reason}]` / `failed[{name,error}]`), `seed`, `startCommand`, and `ok` (`false` when a clone or seed failed). **Agents: prefer `--json --strict`** and read `ok` + `$?` instead of scraping banners.

After creation, the new worktree path is printed at the end (the `path` field with `--json`). `cd` there — at any later point, `cd "$(wtb path <branch>)"` resolves it deterministically — then re-run `wtb ports` to see the *new* worktree's adjusted ports.

### Recovering a skipped/empty volume clone

Use **`wtb reclone [branch]`** to re-run *only* the volume-clone phase on an existing worktree — no need to remove and recreate it (so uncommitted work is safe). Defaults to the current worktree; pass a branch to target another. Accepts the same `--force-volume-copy` / `--no-stop` / `--strict` / `--json` / `--dry-run` flags as `create`, and prints the same `N cloned, N skipped, N failed` summary (a failure exits `0` with the loud not-ready line — pass `--strict` to exit `1` instead). `--json` writes `{ branch, path, dryRun, volumes {cloned[], skipped[], failed[]}, ok }` to stdout. This is the preferred recovery primitive for agents — run it as `wtb reclone [branch] --json --strict`.

```bash
wtb reclone                      # re-clone volumes for the current worktree
wtb reclone feature/auth         # ...for a specific worktree
wtb reclone feature/auth --force-volume-copy   # overwrite stale target data (atomic)
wtb reclone --dry-run            # preview which volumes would be cloned
```

(`reclone` refuses to target the main repository worktree, since source and target would be the same project. To *re-seed* instead of re-clone, just run the configured `volumes.seed_command` inside the worktree.)

Two distinct signals matter, and `create`/`reclone` keep the worktree either way:

- **Failure** — if a clone errors, the per-volume line is `❌ Failed to clone …`, the summary shows `… N failed`, and the final banner is **`⚠️  Worktree created, but N volume(s) FAILED to clone — this worktree's data is NOT fully isolated`** (instead of the `🎉` success banner). Treat this as data-not-ready: surface it, don't proceed as if clean.
- **Skip** — an intentional skip (`source volume … does not exist`, `is in use by …`, or `target … already has data`) means the volume was deliberately not copied; the worktree's DB volume is empty or stale.

To recover from either:

- **Default runs no longer skip just because the source is running** — wtb stops/restarts it automatically. On a default run a skip means one of: `--no-stop` was used; the source stack couldn't be stopped (e.g. Docker daemon error — look for "Could not stop source stack"); the volume is *still* in use after stopping (a shared, explicitly-`name:`d volume held by another Compose project); the target already had data; or the source volume didn't exist yet. The exact reason is printed on the skip line.
- If skipped due to `--no-stop` + a running source: `docker compose stop` the source stack, then `wtb reclone <branch>` (no `--no-stop`) to auto stop-then-copy. (Or copy manually: `docker run --rm -v <src>:/from -v <dst>:/to alpine cp -a /from/. /to/`.)
- If skipped because the target already had data: `wtb reclone <branch> --force-volume-copy` to overwrite (atomic).
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

- `-f, --force` — allow removal with uncommitted changes. Without `-f`, wtb runs its own dirty pre-flight check and fails fast (exit `1`, `Worktree for '<branch>' has uncommitted or untracked changes; commit/stash them or pass -f to force removal`) **before** any Docker teardown or volume deletion — so a dirty worktree never loses its volumes to a doomed removal. Run `wtb ls -l` first to see the `*` dirty flag before deciding.
- `--no-docker` — skip `docker compose down` (useful when the Docker daemon is already stopped).
- `--no-end` — skip `end_command`.
- `--remove-volumes` — also delete the worktree's Docker volumes (`docker compose down -v`). **Destructive for cloned data — confirm with the user.** Note: it only works via the automatic teardown, so it has **no effect** (and wtb prints a `⚠️  --remove-volumes had no effect` warning) when teardown is skipped — i.e. with `--no-docker`, or when `end_command` is set (your `end_command` must run `docker compose down -v` itself). Watch for that warning if you intended to drop the data.

Ordering is: Docker teardown → `end_command` → `git worktree remove`. Setting `end_command` in `wtb.yaml` suppresses the automatic Docker teardown (the user owns shutdown). The default leaves volumes intact (consistent with `docker compose down`); use `--remove-volumes` only if the user explicitly wants the data gone.

## Cleaning up orphaned volumes (`wtb prune`)

Because `wtb remove` leaves volumes by default, wtb-cloned volumes from deleted worktrees accumulate over time. `wtb prune` removes them (plus leftover `*__wtbtmp_*` temp volumes from interrupted overwrites). It only touches `wtb.managed=true`-labelled volumes that belong to **no existing worktree** of this repo.

```bash
wtb prune            # safe preview (dry run) — lists candidates, deletes nothing
wtb prune --json     # machine-readable preview { dryRun, candidates[], removed[], failed[] }
wtb prune --yes      # actually remove — DESTRUCTIVE; confirm with the user first
```

- **Dry run by default** — `wtb prune` and `wtb prune --json` are safe to run autonomously to *show* what would be cleaned up. Only `--yes` deletes, and removing volumes is **data loss** — confirm with the user.
- Volumes currently in use by a container are skipped. A live worktree's volume is matched by exact Compose project prefix, so it is never removed. Each JSON candidate carries `inUse` plus `inUseBy` (the blocking container names).
- With `--yes`, any removal failure exits non-zero (exit code 5, Docker error); with `--json --yes` the JSON payload is still written and `failed[]` lists the volumes that could not be removed. Treat a non-zero exit as a partial prune.

## Inspecting state

```bash
wtb status              # current branch + Docker state (human-readable)
wtb status -a           # all worktrees
wtb status --docker-only # skip the worktree section
wtb status --json       # machine-readable JSON (worktrees + Docker state) — prefer this for agents
wtb status -a --json    # all worktrees, JSON
```

Use `wtb status` for diagnosis when ports look wrong or services are missing — it shells out to `docker ps` and `docker volume ls` to show what is actually running. **For autonomous inspection, prefer `wtb status --json`** — it returns one structured object on stdout (valid JSON even when Docker is down):

```json
{
  "worktrees": [
    { "branch": "feature/auth", "path": "…", "isMain": false, "isCurrent": true,
      "compose": { "file": "docker-compose.yml", "services": 3 },
      "envFiles": [".env", ".env.local"] }
  ],
  "docker": {
    "configured": true, "available": true,
    "version": "Docker version 25.0", "composeVersion": "2.24.0",
    "containers": [ { "name": "…", "image": "…", "status": "Up 3m", "ports": ["0.0.0.0:5433->5432/tcp"], "isWtb": true } ],
    "volumes": { "total": 7, "wtb": [ { "name": "proj_pg", "driver": "local", "labelled": true } ] }
  }
}
```

- `docker.available` is `false` (not an error) when the daemon is down or Docker isn't installed; `docker.configured` reflects whether `docker_compose_file` is set. Check `available` before trusting `containers`/`volumes`.
- This completes the machine-readable trio: `wtb ls --json` (worktrees), `wtb ports` (ports/endpoints, JSON by default), `wtb status --json` (live Docker state).
- `docker.volumes.wtb` lists volumes detected by the `wtb.managed=true` label **plus** a name-based fallback (`wtb`/`worktree` in the name) for volumes created before labelling existed. The fallback can include non-wtb volumes that merely have a matching name — trust the per-entry `labelled` flag before treating a volume as wtb-managed. The label is the exact source of truth (`docker volume ls --filter label=wtb.managed=true`, and what `wtb prune` uses).

## Preflight — relocatability check (`wtb doctor`)

`wtb doctor` is a **static preflight (no Docker)** that inspects this repo's compose + env files for problems that would make worktrees collide instead of isolate — a fixed Compose `name:`/`container_name:`, a literally-published port that won't follow an `env.adjust` bump, an unresolved `${VAR}` in a port mapping, or a `COMPOSE_PROJECT_NAME` set in the shell. Run it before creating a worktree when a stack is unfamiliar, or to diagnose a collision.

```bash
wtb doctor                 # human-readable report
wtb doctor --json | jq .   # machine-readable
wtb doctor --strict        # exit 1 if any warning/error finding exists
```

JSON shape: `{ composeFile, findings: [{ id, severity, message, suggestion }], summary: { info, warning, error }, ok }`. `severity` is `info` | `warning` | `error`; finding ids include `fixed-project-name`, `container-name`, `literal-env-port`, `literal-compose-port`, `unresolved-port-variable`, `compose-project-name-env`, `no-compose-file`. A finding is downgraded to `info` when the relevant auto-handling is enabled (identity rewrite / port propagation — both default ON), and is a `warning` when it's been disabled.

**Exit semantics for agents:** by default `wtb doctor` **exits `0` even when warnings exist** — read `ok` / `summary` from the `--json` output to decide, don't rely on `$?`. Use `--strict` only when you explicitly want a non-zero gate (exit `1` on any warning/error). The same checks run automatically as a preflight inside `wtb create` (and `--dry-run`), printing warning/error findings to stderr, but they **never change create's exit code**.

## Config quick reference

`wtb.yaml` (or any of the other five names in the config search order: `wtb.yml`, `.wtb.yaml`, `.wtb.yml`, `.wtb/config.yaml`, `.wtb/config.yml`) at the repo root. Read it when the user asks "what does wtb do on create?" or when their request hinges on what is configured. No config yet? `wtb init` scaffolds a commented `wtb.yaml` at the repo root (detects `base_branch` from `origin/HEAD`; `--force` overwrites an existing config).

| Field | Purpose |
|-------|---------|
| `base_branch` | Branch new worktrees fork from (default `main`). |
| `docker_compose_file` | Compose file to copy + port-remap. Empty/omitted = Docker skipped. |
| `copy_files` | Files/dirs copied into each worktree (e.g. `.env`). |
| `link_files` | Files/dirs symlinked (e.g. `node_modules`) — priority over `copy_files`. |
| `start_command` / `end_command` | Lifecycle scripts run via `/bin/sh` in the worktree. |
| `env.file` | Env files processed per worktree. |
| `env.adjust` | Per-key transform: `number` = auto-bump to next free port, `string` = literal replace, `null` = remove. |
| `env.port_propagation` | Propagate a bumped port into other env values + the compose copy. Boolean shorthand or `{ enabled, files, compose }`. **Default ON.** |
| `compose.isolate_name` | Rewrite the worktree's top-level Compose `name:` to `<original>-<branch-slug>` so worktrees don't share one project. **Default ON** (`false` to opt out). |
| `compose.container_name` | How to handle services' `container_name:`: `suffix` (append `-<slug>`, default), `strip` (remove; compose auto-generates), `keep` (leave as-is — a 2nd worktree's `up` collides). |
| `volumes.exclude` | Compose volume keys to exclude from auto-cloning. Default `[]` (clone every named non-`external` volume). |
| `volumes.seed_command` | Command run in the worktree when `create --seed` is used, *instead of* cloning volume data (fresh-seeded DB rather than a copy of main's). |

## Installing / updating this skill (`wtb init-claude`)

This skill file is installed by `wtb init-claude`. If the user asks to install, refresh, or update the wtb skill — or you suspect it's stale versus the installed CLI — use it:

```bash
wtb init-claude              # write .claude/skills/wtb/SKILL.md in this repo
wtb init-claude --check      # exit non-zero if the installed skill is missing/older than the CLI
wtb init-claude --force      # overwrite an existing SKILL.md (use when updating)
wtb init-claude --user       # install globally at ~/.claude/skills/wtb/ instead
wtb init-claude --dry-run     # print the target path only; write nothing
```

The installer stamps the file with `<!-- wtb-skill-version: X.Y.Z -->`; `--check` (and the skip message when running `init-claude` without `--force`) compares that stamp against the CLI version, so staleness is machine-detectable — run `--check` after upgrading wtb and `--force` to refresh.

Because `.claude/skills/` is a regular tracked directory, every worktree created with `wtb create` inherits the skill automatically — there's nothing to sync per worktree. After installing, suggest the user `git add .claude/skills/wtb && git commit`. `init-claude` is safe to run autonomously *except* `--force`, which overwrites the existing file — confirm before using it.

## Troubleshooting hints

- "Port still collides" → wtb only scans other worktrees' `.env` files and running Docker containers. Anything else listening on the port is invisible to it. Check with `lsof -i :<port>` and stop the offender.
- "Not in a git repository" (exit 3) → run from inside the repo.
- "Worktree for branch 'X' already exists" (exit 6) → `wtb ls` shows where; `wtb remove X` to clear, or pass `--exists-ok` to `create` if reusing it is fine (prints the path, exit 0).
- Docker daemon down → `wtb ports` is unaffected (it reads the Compose YAML from disk, never Docker). `wtb remove` skips teardown gracefully.
- Config validation error (exit 4) → fields like `base_branch` missing or wrong type. The error message names the bad field.

## Conventions

- All read-only commands (`ls`, `path`, `ports`, `status`, and `wtb prune` without `--yes`) are safe to run without confirmation. `create`, `remove`, `reclone`, and `prune --yes` mutate state — confirm first (`prune --yes` deletes volumes = data loss; `reclone` stops the source stack and with `--force-volume-copy` overwrites target volume data).
- `wtb ports`, `wtb ls --json`, `wtb status --json`, and `wtb prune --json` produce **valid JSON on stdout even when Docker is unavailable**. For these JSON read-commands, warnings/progress go to stderr, so `2>/dev/null` keeps pipes clean. With `create --json` / `reclone --json`, human progress (including the `❌`/`⚠️` lines) moves to **stderr** and stdout carries exactly one JSON object; *without* `--json` they print everything to **stdout** — don't `2>/dev/null` those expecting to hide it.
- Exit codes: `0` success, `1` general error, `2` usage error (bad/missing arguments or flags), `3` not-a-git-repo, `4` config error (invalid/unparseable `wtb.yaml`), `5` Docker error (emitted by `wtb prune --yes` when a removal fails — a partial prune — **and** by `wtb create` / `wtb reclone` when the source Compose stack was stopped to clone but could not be restarted; that exits `5` even without `--strict` and prints a recovery command), `6` worktree already exists (`wtb create` without `--exists-ok`), `130`/`143` interrupted by SIGINT/SIGTERM (an interrupted `create` is in a partial state). **Caveat:** `wtb create` / `wtb reclone` exit `0` by default even when a volume clone or seed failed (the worktree still exists). For machine-readable failure detection, run them with `--strict` so incomplete data isolation exits `1` — ideally `--json --strict`, checking `ok` in the JSON; only when running without `--strict`, fall back to detecting the `⚠️ …` banner on stdout (see [Recovering a skipped/empty volume clone](#recovering-a-skippedempty-volume-clone)). `wtb doctor` is the exception that's *always* exit-0 unless you pass `--strict`.
- `wtb --help` and `wtb <command> --help` are always available for live reference.
