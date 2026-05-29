# Code Style and Conventions for wtb

## TypeScript Configuration

- **Target**: ES2022
- **Module**: ESNext with Node resolution
- **Strict mode**: Enabled
- **Source maps + Declarations**: Generated for debug + types

## Biome (Linting & Formatting)

- 2-space indent, no tabs
- Line width 100
- LF line endings
- Double quotes
- Semicolons inserted as needed (ASI-friendly)
- ES5 trailing commas
- Arrow parens always
- Bracket spacing on

## Code Conventions

- ES modules only (`import`/`export`); no CommonJS
- Prefer `const`; use `let` only when reassigned
- Prefer `??` over `||` when merging defaults so explicit empty arrays / strings survive (this is critical in `mergeWithDefaults`)
- Commands all use the shared `withErrorHandling` action wrapper from `src/cli/utils/command-helpers.ts` — do not reimplement try/catch in new commands
- Git repo guards in CLI commands use `getGitRootOrThrow()` from `src/core/git/repository.ts` — do not call `isGitRepository` + `getGitRoot` separately
- All git/docker calls go through `execGitSafe` / `execDockerSafe` (array args, no shell). `/bin/sh` is **only** used for user-supplied `start_command` / `end_command` via `executeLifecycleCommand`
- JSON-mode purity: log to **stderr** for informational output that might be tee'd through a pipe expecting JSON

## File Organization

- One command per file under `src/cli/commands/`
- Pure renderers under `src/cli/utils/<command>-render.ts` (no IO; testable in isolation)
- Domain logic under `src/core/<area>/` (no CLI imports)
- Public types in `src/types/index.ts`; constants in `src/constants/index.ts`
- Tests colocated as `*.test.ts` for unit; `e2e/cli.test.ts` for CLI black-box tests

## Import Style

- Named imports preferred
- Use `.js` extension in import paths (TypeScript ESM convention; the build emits `.js` and `tsc` requires the original `.ts` import to specify `.js`)

## Adding a New Field to `WtbConfig`

When adding a field to `WtbConfig`, you must touch all of these — easy to forget the merge step:

1. `src/types/index.ts` — type definition
2. `src/constants/index.ts` — `DEFAULT_CONFIG.<field>`
3. **`src/core/config/loader.ts` — extend `mergeWithDefaults` to carry the new field** (forgetting this silently drops user values; see `config_loader_invariants` memory)
4. `src/core/config/validator.ts` — validate type / shape (warning vs error)
5. `src/core/config/loader.test.ts` — regression test that user-supplied value survives merge
6. README.md / README_ja.md / SKILL.md / CHANGELOG.md
