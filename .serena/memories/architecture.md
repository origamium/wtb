# wtb Architecture

## Layers and Dependencies

```
              cli/commands ──┐
                             ├──► core/* ──► utils/*
              cli/utils    ──┘
                              │
                  ┌───────────┴───────────┐
                  ▼                       ▼
              types/index            constants/index
```

CLI commands and CLI-only helpers consume core domain logic. Core never imports from CLI. Both layers freely import types and constants. `utils/` (exec helpers, error formatter) is the lowest level.

For a fuller human-readable architecture document, see `ARCHITECTURE.md` at the repo root.

## Module Map

### `src/types/index.ts`

- `WtbConfig` — top-level config with `base_branch`, `docker_compose_file`, `copy_files`, `link_files`, `start_command`, `end_command`, `env`, `volumes` (optional)
- `EnvConfig` — `{ file: string[]; adjust: Record<string, string|number|null> }`
- `VolumesConfig` — `{ exclude: string[] }`
- `WorktreeInfo`, `EnrichedWorktreeInfo` (+ shortHash/age/dirty for `ls -l`)
- `LsCommandOptions`, `PortsCommandOptions`, `InitClaudeOptions`
- `WorktreePorts` — output of `wtb ports` (path/branch/env/compose/endpoints)
- `ComposeServicePorts`, `ComposeService`, `ComposeConfig`, `ContainerInfo`, `VolumeInfo`
- `CommandOptions`, `CommandContext`, `FileOperationOptions`, `ExecOptions`

### `src/constants/index.ts`

- `APP_NAME = "wtb"`, `APP_VERSION` (dynamic from package.json)
- `CONFIG_FILE_NAMES` — 6 candidates in priority order
- `DEFAULT_CONFIG` — defaults including `volumes: { exclude: [] }`
- `COMPOSE_FILE_NAMES`, `ENV_FILE_NAMES`
- `DOCKER_COMMANDS` — pre-formatted shell strings for `docker ps`/`inspect`/`volume ls`
- `PORT_RANGE` — `{ MIN: 3000, MAX: 9999, SEARCH_LIMIT: 100 }`
- `EXIT_CODES`, `LOG_LEVELS`, `ENV_VAR_PATTERNS`, `WTB_PREFIX`
- `FILE_ENCODING`, `TEMP_DIR_PREFIX`, `BACKUP_EXTENSION`

> `GIT_COMMANDS` does **not** exist (a previous version of this memory referenced it); git ops use `execGitSafe(["...","..."])` directly.

### `src/core/config/`

- `loader.ts`
  - `findConfigFile(dir?)` / `getConfigFilePath(dir?)` / `hasConfigFile(dir?)`
  - `mergeWithDefaults(partial)` — uses `??` (not `||`) so explicit empty arrays survive. **Must list every WtbConfig field explicitly** (regression risk; see `config_loader_invariants` memory).
  - `createDefaultConfig(path?)`, `loadConfig(dir?)`
  - Logs config path to **stderr** (so JSON-mode commands stay clean)
- `validator.ts`
  - `validateConfig(config, configFile)` — warnings to stderr, errors throw with exit code 4
  - Validates types of every field including `volumes.exclude`

### `src/core/git/`

- `repository.ts`
  - `isGitRepository(cwd?)`, `getGitRoot(cwd?)`, `getCurrentBranch(cwd?)`, `branchExists(name, cwd?)`
  - **`getGitRootOrThrow(cwd?)`** — throws `CLIError(NOT_GIT_REPOSITORY)`; the canonical guard for CLI commands
- `worktree.ts`
  - `listWorktrees(cwd?)` — parses `git worktree list --porcelain`
  - `createWorktree(branch, path, opts?)`, `removeWorktree(path, opts?)`
  - `getWorktreePath(branch, cwd?)`, `getWorktreeRelationship(cwd?)`
- `commit-info.ts` — used by `wtb ls -l`
  - `getCommitInfo(cwd)`, `isDirty(cwd)`, `enrichWorktree(wt) → EnrichedWorktreeInfo`

### `src/core/docker/`

- `client.ts`
  - `getRunningContainers(opts?)`, `getDockerVolumes(opts?)`, `getUsedPorts(opts?)`
  - `isWtbContainer(c)` — name-substring or `WTB_*` env-var check
  - `getDockerInfo(opts?)` — `docker --version` / `docker-compose --version`
- `compose.ts`
  - `readComposeFile(path, opts?)` / `writeComposeFile(path, config, opts?)`
  - `parsePortMapping(s)` — handles `"host:cont"`, `"0.0.0.0:host:cont"`, `"host:cont/tcp"`
  - `adjustPortsInCompose(config, usedPorts)` — deep-clones, returns adjusted
  - `findComposeFile(dir)`, `validateComposeConfig(config)`
  - `generateProjectName(dir, branch?)` — legacy; **do not use** for volume name resolution (replaces non-alphanumeric with dashes — wrong)
  - **`resolveComposeProjectName(config, workdir, env=process.env)`** — Compose v2 spec-correct: precedence `name:` > `COMPOSE_PROJECT_NAME` > normalized dir basename. See `compose_project_name_rules` memory.
- `volume.ts` — Docker named-volume operations
  - `getVolumeSize(name)`, `volumeExists(name)`, `createVolume(name, driver?)`
  - `getContainersUsingVolume(name)` — `docker ps --filter volume=...`
  - `copyVolume(source, target, opts?)` — rsync sidecar (`instrumentisto/rsync-ssh`) with `cp -a` fallback. `clearTarget: true` translates to rsync `--delete` and cp's pre-clearing `find /target -mindepth 1 -delete`.
  - `copyVolumeWithRsync` / `copyVolumeWithCp` — internal but exported for testing
  - `resolveVolumeName(composeConfig, key, projectName)` — returns `{ name, external }`. Honors compose's `volumes.<key>.name` and `external: true | { name }`. With external+no name, returns `{ name: <key>, external: true }`.
  - `discoverCloneableVolumes(composeConfig, exclude)` — non-external named volume keys minus exclude list
  - `formatBytes`, `formatEta`

### `src/core/environment/processor.ts`

- `EnvLine = { type:"entry"; key; value; comment? } | { type:"other"; content }`
- `parseEnvFile(path, opts?) → ParsedEnvFile` — line-order-preserving
- `serializeEnvFile(parsed)`, `writeEnvFile(path, parsed, opts?)`
- `copyAndAdjustEnvFile(src, dst, adjustments, opts?, usedPorts?)` — string/number/null/function adjustments; null deletion via `Set<string>` (no sentinel collisions)
- `backupEnvFile`, `restoreEnvFile`

### `src/utils/`

- `exec.ts`
  - `execSafeSync(file, args, opts?)` — `execFileSync` wrapper, no shell
  - `execGitSafe(args, opts?)`, `execDockerSafe(args, opts?)`
  - `executeLifecycleCommand(command, cwd)` — **the only** exec path that uses `/bin/sh`; for user-supplied `start_command`/`end_command`
- `error.ts`
  - `class CLIError extends Error { exitCode: number }`
  - `getErrorMessage(error)`

### `src/cli/`

- `index.ts` — `createMainProgram()` registers all 6 commands with version/description, `setupErrorHandling()`, `main()`
- `commands/{create,remove,ls,ports,status,init-claude}.ts` — each exports a factory returning a Commander `Command`
- `utils/`
  - `command-helpers.ts` — `withErrorHandling(fn)` wraps a command action, converting `CLIError` to its declared exit code and other errors to `GENERAL_ERROR`. **All 6 commands use this** for consistency.
  - `worktree-render.ts` — pure renderers for `ls`: `renderDefault`, `renderLong`, `renderJson`, `renderPaths`
  - `ports-render.ts` — pure renderers for `ports`: `renderPortsJson`, `renderPortsPretty`
  - `claude-skill-install.ts` — `installClaudeSkill(opts, cwd?)`, with `resolveTemplateRoot()` working from both src/ and dist/ depth
  - `progress.ts` — `createProgressBar`, `formatVolumeCopyProgress`, `updateProgressLine`, `finishProgressLine`, `createVolumeCopyProgressHandler` (only the ones actually used by volume-clone; Spinner / MultiVolumeProgressTracker were dropped as dead code)

## Data Flow — `wtb create <branch>`

7-phase pipeline (with phase 6.5 added in v1.1.0):

```
1. ensureGitRepository / branch existence check / sanitize path
2. createWorktree (git worktree add) [branching from base_branch if new]
3. copyConfiguredFiles (copy_files)        [skip: --no-copy]
4. linkConfiguredFiles (link_files)        [skip: --no-link]
5. applyEnvAdjustments (env.file × env.adjust)  [skip: --no-env]
6. setupDockerCompose (read+adjust+write)   [skip: --no-docker]
6.5. setupVolumeCopy (clone non-external volumes from source project)
                                              [skip: --no-volume-copy or --no-docker]
7. executeStartCommand                      [skip: --no-start]
[Final] print Tip about init-claude if .claude/skills/wtb missing
```

Volume clone uses Compose's actual project name resolution (via `resolveComposeProjectName`) so `<project>_<volume>` lookups match what `docker compose up` will create. Auto-discovery: every named non-`external` volume in `composeConfig.volumes`, minus `config.volumes.exclude`. Skip paths: source missing / source container running / target populated. `--force-volume-copy` lifts the latter two; setupVolumeCopy then propagates `clearTarget: true` so the cp fallback also overwrites.

## Data Flow — `wtb remove <branch>`

```
1. ensureGitRepository / find worktree / refuse to remove main
2. loadConfig
3. (config.docker_compose_file && !skipDocker && !end_command):
     `docker compose down` [or `down -v` if --remove-volumes]
4. (config.end_command && !skipEnd):
     `executeLifecycleCommand(end_command, worktreePath)` (non-fatal)
5. removeWorktree(worktreePath, { force: --force })
6. print remaining worktrees
```

Setting `end_command` suppresses the automatic `docker compose down` (the user owns teardown).

## Data Flow — `wtb ls`

- `listWorktrees()` (1 git call)
- if `-l`: `Promise.all(worktrees.map(enrichWorktree))` for parallel git log + git status per worktree
- render via worktree-render's pure functions

## Data Flow — `wtb ports`

- pickCurrentWorktree (or all)
- per-worktree: read env files for adjusted keys; read+parse compose for service ports; build `endpoints[]`
- emit JSON to stdout (default) or pretty table (`--pretty`)
- config-loading log goes to **stderr** so stdout stays valid JSON

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Invalid CLI usage (Commander) |
| 3 | Not in a git repository |
| 4 | Configuration validation error |
| 5 | Docker error |

## Cross-Cutting Mechanisms

- **Port collision avoidance** (3 layers): running containers via `getUsedPorts()`, other worktrees' env files, in-pass `Set<number>` to prevent same value being assigned twice
- **`.env` order preservation**: EnvLine union, Set-based deletion (no `__DELETE__` sentinel)
- **Shell-injection prevention**: `execFileSync` array args for all git/docker; `/bin/sh` only for user lifecycle scripts
- **Claude skill template discovery**: `path.resolve(import.meta.url, "..", "..", "..", "templates")` — same depth from src/ or dist/, so works in dev and from npm tarball
- **JSON-mode purity**: `loadConfig` writes its info banner to stderr; `ports` defaults to JSON; `ls --json` & `ports` produce parseable stdout regardless of Docker availability
