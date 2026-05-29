# wtb Project Overview

## Purpose

`wtb` is a TypeScript CLI tool that integrates Git worktree with Docker Compose to give every branch its own isolated dev environment — automatic `.env` copying, port remapping, Docker Compose isolation, **named-volume cloning so each branch starts with the source's data (e.g. PostgreSQL)**, and symlinks for heavy directories.

Distributed as `@schemelisp/wtb` on npm. CLI binary: `wtb`.

## Tech Stack

- **Language**: TypeScript (ES2022, ESNext modules), Node.js >= 18
- **CLI Framework**: Commander.js v14
- **Runtime deps**: `commander`, `fs-extra`, `yaml`
- **Build**: `tsc` → `dist/`
- **Test**: Vitest (`npm run test:unit` for src/, `npm run test:e2e` for e2e/)
- **Lint/Format**: Biome
- **Dev**: tsx
- **Package**: scoped `@schemelisp/wtb`, `bin: { wtb: "dist/cli/index.js" }`, ships `dist/`, `templates/`, `README.md`, `LICENSE`

## Commands

All exposed CLI commands:

- `wtb create <branch>` — create worktree (7-phase pipeline incl. volume clone)
- `wtb remove <branch>` — teardown (compose down → end_command → worktree remove); `--remove-volumes` for `down -v`
- `wtb ls` (alias: `list`) — fast scriptable listing; `--json` / `-l` / `-p`
- `wtb ports` — JSON-by-default endpoint dump for Claude Code skill / scripts; `--all` / `--pretty`
- `wtb status` — human-readable worktree + Docker state (no JSON mode)
- `wtb init-claude` — install bundled `templates/claude/skills/wtb/SKILL.md` to `.claude/skills/wtb/`; `--user` / `--force` / `--dry-run`

Read-only commands (`ls`, `ports`, `status`) are safe to call autonomously. Mutating commands (`create`, `remove`) require explicit user intent.

## Project Structure

```
src/
├── index.ts                # library re-export of cli/index
├── cli/
│   ├── index.ts            # commander wiring + main()
│   ├── commands/           # one file per command
│   │   ├── create.ts       # 7-phase pipeline (incl. setupVolumeCopy phase 6.5)
│   │   ├── remove.ts
│   │   ├── ls.ts
│   │   ├── ports.ts
│   │   ├── status.ts
│   │   └── init-claude.ts
│   └── utils/              # CLI-side helpers
│       ├── command-helpers.ts    # withErrorHandling wrapper
│       ├── worktree-render.ts    # ls renderers
│       ├── ports-render.ts       # ports renderers
│       ├── claude-skill-install.ts
│       └── progress.ts           # volume-copy progress display
├── core/                   # CLI-agnostic business logic
│   ├── config/
│   │   ├── loader.ts       # findConfigFile / loadConfig / mergeWithDefaults
│   │   └── validator.ts
│   ├── git/
│   │   ├── repository.ts   # isGitRepository / getGitRoot / getGitRootOrThrow
│   │   ├── worktree.ts
│   │   └── commit-info.ts  # enrichWorktree (ls -l)
│   ├── docker/
│   │   ├── client.ts       # getRunningContainers / getUsedPorts / isWtbContainer
│   │   ├── compose.ts      # readComposeFile / adjustPortsInCompose / parsePortMapping / resolveComposeProjectName
│   │   └── volume.ts       # copyVolume / resolveVolumeName / discoverCloneableVolumes / volumeExists / getContainersUsingVolume / getVolumeSize
│   └── environment/
│       └── processor.ts    # parseEnvFile / copyAndAdjustEnvFile (line-order-preserving)
├── utils/
│   ├── exec.ts             # execSafeSync / execGitSafe / execDockerSafe / executeLifecycleCommand
│   └── error.ts            # CLIError / getErrorMessage
├── constants/
│   └── index.ts            # APP_NAME, DEFAULT_CONFIG, EXIT_CODES, PORT_RANGE, WTB_PREFIX, etc.
├── types/
│   └── index.ts            # WtbConfig, VolumesConfig, WorktreePorts, EnrichedWorktreeInfo, ContainerInfo …
└── test/
    ├── helpers/            # createWtbConfig, docker-test-helper
    ├── fixtures/           # docker-project compose fixture
    └── setup.ts

e2e/                        # vitest e2e tests (real git, optional Docker)
templates/claude/skills/wtb/SKILL.md     # ships in npm tarball
sample/                     # runnable Postgres + Next.js + Debian playground
```

## Configuration (`wtb.yaml`)

Search order: `wtb.yaml` → `wtb.yml` → `.wtb.yaml` → `.wtb.yml` → `.wtb/config.yaml` → `.wtb/config.yml`.

```yaml
base_branch: main
docker_compose_file: ./docker-compose.yml

copy_files:
  - .env
  - .env.local
  - .secrets

link_files:                 # priority over copy_files; ideal for node_modules
  - node_modules
  - .cache

start_command: npm install && npm run db:migrate
end_command: docker compose down

env:
  file: ["./.env"]
  adjust:
    APP_PORT: 1             # number → auto-bump to next free port
    DB_PORT: 1
    API_KEY: "dev-key"      # string → literal replace
    DEBUG_PORT: null        # null → remove key

volumes:
  exclude:                  # default: clone every named non-external volume
    - cache_data            #   listed keys are skipped
```

## Key Behaviors

- Cross-worktree port adjustment scans other worktrees' env files for collisions
- `.env` parser preserves line order, comments, blank lines; supports null deletion via `Set<string>` (no sentinel collision)
- Compose-spec-correct project name resolution for volume name lookup (precedence: `name:` > `COMPOSE_PROJECT_NAME` > dir basename)
- All git/docker calls use `execFileSync` (array args) to avoid shell injection; only user-provided `start_command` / `end_command` go through `/bin/sh`

## Distribution

- v1.0.1 published; v1.1.0 adds volume auto-clone (PR #8 in flight)
- LICENSE: MIT
- Repository: github.com/origamium/wtb
