# Session history — 2026-05 (rename + cleanup + volume clone)

This memory captures what happened in the long working session that took the project from `wturbo` to `wtb` and added Docker named-volume auto-cloning. Useful for catching context if you pick up work later in this branch family.

## PRs

| PR | Branch | Status | Topic |
|---|---|---|---|
| #5 | `rename/wtb` → `main` | **MERGED** | rename `wturbo` → `wtb` (package, CLI binary, config files, env-var prefix, types, skill dir, repo URLs); npm update; ARCHITECTURE.md rewrite |
| #6 | `refactor/tier2-cleanup` → `rename/wtb` | **MERGED** (into rename/wtb only) | dead code removal (progress.ts / volume.ts), `withErrorHandling` + `getGitRootOrThrow` consolidation, `wtb status` error path consistency, CHANGELOG.md, `prepublishOnly` runs tests, README/SKILL refresh |
| #8 | `feat/volume-clone` → `main` | **OPEN** | Docker volume auto-clone feature (the headline addition) — 17 commits, includes review-fix follow-ups |

PR #6's content reached `main` only via PR #8's diff (since #6's base was `rename/wtb`, not `main`, and `rename/wtb` wasn't re-merged after #6 landed). So PR #8 is bundled — main + tier-2-cleanup + volume-clone.

## Critical bugs caught and fixed during the session

### 1. Compose project name normalization mismatch (caught by manual e2e)

`generateProjectName` replaced non-alphanumeric with `-`, but Compose v2 strips them and preserves underscores. A workdir with `_` or `.` would silently make volume clone skip with "source volume does not exist." Fix: new `resolveComposeProjectName` in `src/core/docker/compose.ts` matches Compose's actual rule. See `compose_project_name_rules` memory.

### 2. `volumes.exclude` dropped by `mergeWithDefaults` (caught by Codex P1 + Copilot review)

`src/core/config/loader.ts:mergeWithDefaults` listed every `WtbConfig` field explicitly but missed `volumes`. So even though `DEFAULT_CONFIG.volumes` and `validator.ts` were correctly added, user-supplied `volumes.exclude` in `wtb.yaml` was silently dropped before it reached `setupVolumeCopy`. Fix: extend `mergeWithDefaults`. Now there's a regression test in `loader.test.ts`. Lesson recorded in `config_loader_invariants` memory.

### 3. `--force-volume-copy` overwrite promise broken on cp fallback (caught by Copilot review)

`copyVolume` falls back from rsync to `cp -a` when the rsync image isn't available. The cp path didn't delete files that exist only in target — so "force overwrite" didn't actually clear stale data. Fix: `clearTarget: boolean` option, propagated by `setupVolumeCopy` only when `force=true && targetSize > 0`. cp path now runs `find /target -mindepth 1 -delete` before the cp. rsync path uses `--delete`.

### 4. `COMPOSE_PROJECT_NAME` env var ignored (self-review)

`resolveComposeProjectName` looked at `composeConfig.name` and the directory basename but skipped the `COMPOSE_PROJECT_NAME` env var. Users who export it to override Compose's default would see wtb compute different volume names than Compose actually used. Fix: `resolveComposeProjectName` now takes `env: NodeJS.ProcessEnv = process.env` and consults `env.COMPOSE_PROJECT_NAME` between the explicit `name:` field and the dir basename. 4 new unit tests.

### 5. JSDoc / impl mismatch on `resolveVolumeName` (caught by Copilot review)

JSDoc said "external: true with no name returns null" but the implementation returns `{ name: <volumeKey>, external: true }`. The implementation is correct (Compose treats the key as the external volume name); the JSDoc was stale. Fixed.

### 6. Dead code residue after partial restoration (self-review)

When restoring the deleted `volume.ts` and `progress.ts` from git history for the volume-clone feature, I dropped `Spinner` / `MultiVolumeProgressTracker` (genuinely unused) but accidentally kept `copyVolumesParallel` / `getVolumeDetails` / `removeVolume` / unused option fields. Cleaned up in the review-response commits.

## Current branch state

- `feat/volume-clone` carries 17 commits ahead of `main`:
  - 6 commits from tier2-cleanup (LICENSE, dead-code, boilerplate, CHANGELOG, READMEs, SKILL fix)
  - 7 commits for volume clone (restore + schema + pipeline + docs + 2 fixes + 1 progress cleanup)
  - 4 commits from review response (mergeWithDefaults / COMPOSE_PROJECT_NAME / clearTarget+dead-code+JSDoc / orchestration tests)
- Test counts: started session at 241 passing; PR #8 (post-review) is at **284 passing** (140 unit + ... + 11 setupVolumeCopy + 16 compose project name + 14 volume helpers + 101 e2e)
- Remote: `git@github.com:origamium/wtb.git` (the repo was renamed at GitHub from `wturbo` → `wtb` mid-session)

## Repository naming history

- pre-2026-05: `wturbo` (and `WTCompose` before that, per old serena memories)
- mid-2026-05: rename to `wtb`. NPM package becomes `@schemelisp/wtb`, GitHub repo renamed to `origamium/wtb`. No backwards-compat for old config file names or env-var prefixes.

## Key documents created during the session

- `LICENSE` — MIT (added on `main` separately, cherry-picked into the tier2-cleanup branch)
- `CHANGELOG.md` — Keep a Changelog format, tracks 1.0.0 / 1.0.1 / Unreleased
- `ARCHITECTURE.md` — substantially rewritten in PR #5 to reflect actual current state (the previous version listed nonexistent `system.ts`/`file.ts`/`GIT_COMMANDS`)
- `templates/claude/skills/wtb/SKILL.md` — Claude Code skill that's auto-installed via `wtb init-claude`
- README.md / README_ja.md — refreshed for parity, install commands corrected (`@schemelisp/wtb`)
