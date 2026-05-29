# Task Completion Checklist for wtb

## Before Committing Changes

### 1. Type Checking
```bash
npm run typecheck
```
Must pass with zero errors.

### 2. Lint / Format
```bash
npm run check     # biome check --write (auto-fix lint + format)
```
Or just `npm run lint` to verify without writing.

### 3. Build
```bash
npm run build
```
Must compile cleanly to `dist/`. `prepublishOnly` runs this anyway.

### 4. Tests
```bash
npm run test:run    # full suite (unit + e2e); same as prepublishOnly
# or split:
npm run test:unit
npm run test:e2e    # may flake on disk-IO race; rerun once if it does
```
Add unit tests for new pure logic. Add e2e cases for new commands/flags.

### 5. Functional smoke test (when changing CLI behavior)
```bash
node dist/cli/index.js --help              # commands list
node dist/cli/index.js <changed-cmd> --help  # verify new flags
# end-to-end in /tmp scratch dir or sample/
```

## Common modification patterns

### Adding a new field to `WtbConfig`

Touch all 5 files (forgetting any of them silently breaks the feature — this happened with `volumes.exclude` and was caught by Codex/Copilot review):

1. `src/types/index.ts` — interface field
2. `src/constants/index.ts` — `DEFAULT_CONFIG.<field>`
3. **`src/core/config/loader.ts` — extend `mergeWithDefaults` to carry the new field** ← easy to forget
4. `src/core/config/validator.ts` — type/shape validation
5. `src/core/config/loader.test.ts` — regression test that user value survives merge

Then docs:

- README.md (Configuration table + relevant section)
- README_ja.md (parity)
- `templates/claude/skills/wtb/SKILL.md` (Config quick reference table)
- CHANGELOG.md (`Unreleased` section)

### Adding a new CLI command

1. `src/cli/commands/<name>.ts` — exports a `<name>Command(): Command` factory
2. Register via `program.addCommand(<name>Command())` in `src/cli/index.ts`
3. Use `withErrorHandling(...)` from `src/cli/utils/command-helpers.ts` for the `.action()` body, not a hand-rolled try/catch
4. Use `getGitRootOrThrow()` from `src/core/git/repository.ts` if the command requires a git repo; do not call `isGitRepository` + `getGitRoot` separately
5. JSON-mode commands: write the JSON body to `process.stdout.write(...)` and any informational logs to **stderr**, so `2>/dev/null` keeps pipes valid
6. Unit-test pure renderers under `src/cli/utils/<command>-render.ts`; e2e-test via Commander's `parseAsync` with `vi.mock` of git/docker layers

### Adding a new exec call

Always go through `execGitSafe` / `execDockerSafe` / `execSafeSync` from `src/utils/exec.ts`. Do **not** use `execSync(...)` directly — exception is `executeLifecycleCommand` which is the single sanctioned `/bin/sh` exec for user-supplied lifecycle scripts.

## Publishing

`npm publish --access public` — `prepublishOnly` runs `clean && build && test:run` first. If publishing manually, ensure the working tree is clean and on the intended tag.
