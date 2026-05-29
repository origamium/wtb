# Docker Compose v2 Project Name Rules (empirical)

These rules are critical because volume name resolution in wtb depends on knowing the project name exactly. Mismatched normalization → silent skip ("source volume does not exist") on volume clone.

## Precedence (highest first)

Following Docker Compose v2's own docs and verified empirically with `docker compose config --format json | jq -r '.name'`:

1. **`--project-name <name>` flag** on the docker-compose CLI invocation
2. **`COMPOSE_PROJECT_NAME` environment variable** (if non-empty)
3. **`name:` field at the top of `docker-compose.yml`** (verbatim, no normalization)
4. **Directory basename**, normalized

For wtb's volume clone, we cannot influence (1) (we don't invoke `docker compose` ourselves for clone). So `resolveComposeProjectName` walks (3) → (2) → (4).

## Directory basename normalization

The rule that bit us: Compose **strips** invalid characters; it does NOT replace them.

```
input              → Compose project name
─────────────────────────────────────────
my-app             → my-app                 (allowed chars unchanged)
my_app             → my_app                 (underscore preserved!)
My App             → myapp                  (lowercase, space stripped)
my-app.v2          → my-appv2               (dot stripped)
worktree.AB12      → worktreeab12           (dot stripped, lowercased)
123proj            → 123proj                (leading digit OK)
_leading           → invalid (starts with underscore)
```

Allowed character class: `[a-z0-9_-]`. Anything else is removed (not replaced). First character must be a letter or digit.

## Why `generateProjectName` is wrong

`src/core/docker/compose.ts:generateProjectName` replaces non-alphanumeric with `-`. For workdir `my_proj` it returns `my-proj`, but Compose actually uses `my_proj`. Volume name lookup `<project>_<key>` then misses. **Never use `generateProjectName` for volume name resolution.**

It is kept around only for the very-rare "wtb-project" fallback when the dir basename can't be derived; a future refactor could remove it entirely.

## `resolveComposeProjectName` (the right one)

Located at `src/core/docker/compose.ts`. Signature:

```typescript
export function resolveComposeProjectName(
  composeConfig: ComposeConfig,
  workdir: string,
  env: NodeJS.ProcessEnv = process.env,
): string
```

Returns:

1. `composeConfig.name` if non-empty string
2. `env.COMPOSE_PROJECT_NAME` if non-empty string
3. Normalized basename: `workdir.split("/").pop()!.toLowerCase().replace(/[^a-z0-9_-]/g, "")`
4. If the normalized result is empty → `"wtb-project"`
5. If the normalized result starts with a non-alphanumeric → prepend `wtb` (so `_data` → `wtb_data`)

## Verifying empirically

If something looks off, ground-truth what Compose actually computes:

```bash
cd <repo-with-docker-compose.yml>
docker compose config --format json | jq -r '.name'
```

Compare with what wtb's resolver would return for the same inputs. The 16 unit tests in `src/core/docker/compose.test.ts` cover the cases I empirically observed.

## References

- `src/core/docker/compose.ts:resolveComposeProjectName`
- `src/core/docker/compose.test.ts` (16 tests)
- Compose spec: https://docs.docker.com/compose/project-name/
- Issue history: https://github.com/docker/compose/issues/2923 (underscore preservation), #9741 (project name spec restrictions)
