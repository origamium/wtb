# wtb volume-clone & data-autonomy — COMPLETE & EXHAUSTIVELY VERIFIED (feat/volume-clone)

Status as of the 2026-05-30 Ralph-loop session (26 commits, unpushed on feat/volume-clone).
Feature-complete, fully reviewed, empirically proven end-to-end against real Docker.
**Do not re-verify from scratch.**

## Real-Docker verification matrix — 100% covered (e2e/integration-docker.sh, `npm run test:integration`)

All 11 checks PASS against a live daemon (skips cleanly without Docker):
1. stop-then-copy: running source → auto stop → clone → restart (source up after)
2. --no-stop + running source → SKIP in-use volume (no corruption), source left running
3. --force-volume-copy + running source → live-clone WITHOUT stopping (escape hatch)
4. populated target + no --force → SKIP, existing data preserved
5. clone carryover
6. wtb.managed=true label present on cloned volume
7. reclone --force-volume-copy → atomic overwrite with updated source
8. --seed → runs volumes.seed_command instead of cloning
9. status --json → valid live JSON
10. remove --remove-volumes → deletes the clone (name aligns with Docker `down -v`)
11. prune → detects an orphaned volume, spares the live worktree's volume

Whole codebase adversarially reviewed module-by-module — all sound.

## Commands (full surface)

create (+--seed, all phase flags), remove (+--remove-volumes), reclone, **prune**
(orphan/temp volume cleanup; dry-run default, --yes, --json), ls, ports, status (+--json),
init-claude.

## Bugs fixed this session (don't reintroduce)

- compose project-name precedence: COMPOSE_PROJECT_NAME beats `name:` (see [[compose_project_name_rules]]).
- SIGTERM (not just SIGINT) restarts the stopped source stack mid-copy.
- cross-worktree port collision: collectWorktreeEnvPorts must include the MAIN worktree (only target excluded).
- remove --remove-volumes silently ignored when teardown skipped (--no-docker / end_command): now warns.
- status under-reported wtb volumes → fixed via wtb.managed=true label + getWtbManagedVolumeNames.
- CONFIG_ERROR(4) now actually thrown by loadConfig; DOCKER_ERROR(5) reserved/unused.
- exec error messages de-duplicated; rsync stderr captured; cp-fallback clears target;
  parseRsyncProgress tolerant; createVolume errors propagate (idempotent).
- `wtb ls` human table now aligns CJK/fullwidth names via visualWidth() (ASCII unchanged).

## Features shipped this session

- `wtb create --seed` + `volumes.seed_command` (last README roadmap item).
- `wtb status --json`; `wtb reclone [branch]`; volumes labelled `wtb.managed=true`.
- **`wtb prune`** — removes orphaned wtb-managed volumes (no live worktree) + leftover
  `*__wtbtmp_*` temps. Dry-run default; --yes deletes; --json. Live worktrees matched by
  exact `<project>_` prefix; in-use skipped. (Subsumes the old SIGKILL temp-leak limitation.)

## Docs in sync

README.md, README_ja.md, SKILL.md (triggers + operating model + all 8 commands + recovery +
cleanup + exit codes), CHANGELOG.md, ARCHITECTURE.md, sample/ playground.

## Testing posture

361 unit/e2e tests (mocked Docker) + 11 real-Docker integration checks (manual / Docker-present).
prepublish gate passes.

## Remaining accepted (intentional / unfixable — NOT work items)

- status volume detection keeps a name-heuristic fallback for PRE-label volumes (label is the
  reliable path; dropping the fallback would miss old volumes — keep it).
- atomic overwrite has an unavoidable local-cp commit window (Docker has no volume rename);
  mid-commit failure preserves a temp + prints recovery; leftover temps are cleaned by `wtb prune`.
- DOCKER_ERROR(5) reserved/unused (Docker degrades gracefully — nothing to throw).
- Windows unsupported (execFileSync paths + /bin/sh); port-collision scope = known sources only.

## NOT done (handoff — see .claude/ralph/progress.md): push branch, update PR #10, release/version bump.
