# wtb — handoff task list (next session)

Branch: `feat/volume-clone` — **26 commits committed locally, NOT pushed.** PR #10 exists.
Working tree clean. 361 unit/e2e tests + 11 real-Docker checks green; prepublish gate passes.

The volume-clone / data-autonomy feature is **complete and exhaustively verified** (see
`.serena/memories/volume_clone_feature_complete.md` for the full done-state + matrix).
The deferred *engineering* work has now been done too (`wtb prune`, CJK `ls` alignment).
What remains is outward-facing ship/release work plus a few intentional non-items.

---

## A. Ship the work (immediate — needs the human / outward-facing)

- [ ] **Push the branch**: 26 local commits on `feat/volume-clone` are unpushed.
      `git push origin feat/volume-clone` (last session hit an SSH-key issue; an HTTPS-token
      URL worked as a fallback).
- [ ] **Update PR #10** body to reflect the full scope (5 bug fixes; `--seed`, `status --json`,
      `reclone`, `prune`, volume labeling; CJK ls alignment; real-Docker integration script).
- [ ] **Re-run Codex/ultrareview** on the updated PR if desired (a prior Codex P1 is already fixed).

## B. Release (needs a maintainer decision)

- [ ] All changes are under `CHANGELOG.md` **[Unreleased]**; `package.json` is still **1.0.1**.
      Decide the version bump (minor — several new commands/flags) and cut a release: bump
      package.json, tag, GitHub release, `npm publish`. (`version-bump` skill exists.) `files`
      already includes `templates/` so `init-claude` works from the published package.

## C. Intentional non-items (accepted by design — do NOT "fix" without a product reason)

- `status` volume detection unions the `wtb.managed=true` label with the legacy name heuristic
  so PRE-label volumes are still recognized. Drop the heuristic only once no pre-label volumes
  can exist (a breaking-ish cleanup). Keeping it is correct.
- Atomic overwrite has an unavoidable local-cp commit window (Docker has no volume rename).
  Mid-commit failure preserves the temp + prints recovery; leftover temps are swept by
  `wtb prune`.
- `DOCKER_ERROR` (exit 5) is reserved/unused — Docker degrades gracefully (warns); nothing
  throws it. Wire only if hard Docker failures should become fatal.
- Windows unsupported (`execFileSync` paths + `/bin/sh`). Port-collision scope = known sources
  (other worktrees' `.env` + running containers), not arbitrary OS sockets.

## D. Optional ideas (not committed scope)

- [ ] **`--seed` + `--no-docker` sharp edge:** with `--no-docker` the compose file isn't copied,
      so a `seed_command` calling `docker compose ...` fails (loud not-ready banner, exit 0).
      Add a guard/warning, or leave (rare combo).
- [ ] **Shell completion** (`wtb completion bash|zsh`).
- [ ] **Heavier E2E:** `npm run test:integration` uses a busybox stack. A full two-worktree run
      of the `sample/` Next.js+Postgres app (both up on different ports, endpoints reachable)
      would prove code+data autonomy with a real app — heavy; exercises the sample more than
      wtb core, so deferred.

---

## Done this session (for reference — do NOT redo)

- 5 bugs fixed: compose project-name precedence, SIGTERM restart, cross-worktree port collision
  with main, silent `--remove-volumes`, status under-reporting. + CJK `ls` alignment.
- Shipped: `--seed` (last roadmap item), `status --json`, `reclone`, volume labeling, **`wtb
  prune`** (orphan/temp cleanup — subsumes the old SIGKILL temp-leak deferral).
- Reviewed every source module; verified the full **11/11** volume-clone matrix against real
  Docker (incl. stop-then-copy, safety guards, escape hatch, lifecycle cleanup, prune detection).
- Synced README/README_ja/SKILL.md/CHANGELOG/ARCHITECTURE; fixed + enriched the `sample/`
  playground. 361 tests + 11 real-Docker checks green. Full detail in the serena memory above.
