# wtb volume-clone & data-autonomy feature — COMPLETE (2026-05-30, feat/volume-clone)

The data-autonomy feature set is feature-complete on `feat/volume-clone`. Every
worktree starts CODE- and DATA-autonomous for humans and coding agents.

## What ships

- **Auto volume clone** on `wtb create`: every named non-external compose volume
  copied source→worktree-project. rsync sidecar primary, `cp -a` fallback.
- **Stop-then-copy** (crash-safe): if source containers run, wtb stops the source
  stack, clones, restarts in a `finally`. Restart also wired to **SIGINT + SIGTERM**
  (create.ts prepends restartOnAbort; cli/index.ts handles both signals).
- **Atomic force-overwrite** (`--force-volume-copy`): stage source→temp volume,
  verify non-empty (abort if `getVolumeSize` returns null/unknown), then
  clear+refill target locally. A failed copy never empties the target; a
  mid-commit failure preserves the verified temp + prints a recovery command.
- **Partial-failure surfacing**: setupVolumeCopy returns {copied,skipped,failed};
  failed>0 flips the success banner to a loud `⚠️ … data is NOT fully isolated`
  (exit stays 0 — don't gate readiness on $? alone; detect the banner).
- **Seed instead of clone** (`--seed` + `volumes.seed_command`): skips clone,
  runs a seed command in the worktree, never touches the source volume (no stop).
  Missing seed_command→exit 4; +--force-volume-copy→exit 1; failed seed→NOT-ready banner.

## Key correctness fixes made this pass

- **Project-name precedence**: COMPOSE_PROJECT_NAME beats compose `name:` (Docker
  v2 order, ground-truthed). See [[compose_project_name_rules]]. Prior inversion
  silently skipped clones.
- **CONFIG_ERROR(4) now real**: loadConfig throws CLIError(4) on invalid config.
  Exit code 5 (DOCKER_ERROR) is RESERVED/never emitted — Docker degrades gracefully.
- rsync stderr folded into thrown error; cp fallback clears fresh target first;
  createVolume errors no longer swallowed (docker volume create is idempotent);
  parseRsyncProgress extracted (tolerates missing ETA, speed=0 on unknown unit).

## Testing posture

317 tests (16 files): unit tests boundary-mock execDockerSafe/spawn for volume
ops; e2e uses real git repos but avoids the Docker daemon (no-docker project for
seed). `--no-docker` also skips volume cloning (phase gated on Docker).

## Files

- src/core/docker/volume.ts (copy*, atomic overwrite, parseRsyncProgress, sizes)
- src/cli/commands/create.ts (setupVolumeCopy, --seed, executeSeedCommand, banner)
- src/core/docker/compose.ts (resolveComposeProjectName, composeStop/Start)
- src/core/config/{loader,validator}.ts (volumes.seed_command, CONFIG_ERROR)
- Docs: README.md, README_ja.md, templates/claude/skills/wtb/SKILL.md, CHANGELOG.md
