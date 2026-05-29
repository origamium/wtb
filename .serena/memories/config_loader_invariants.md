# Config loader invariants

These are sticky pitfalls when modifying `WtbConfig`. They are written here because we have already shipped one bug for each.

## The cardinal rule

When you add a new field to `WtbConfig`, you must touch **all five** files. Forgetting any of them either fails the type check (loud, easy to fix) or silently drops user values (quiet, ships in production).

| Step | File | Why it matters |
|---|---|---|
| 1 | `src/types/index.ts` | The type definition |
| 2 | `src/constants/index.ts` (`DEFAULT_CONFIG`) | The fallback value when user omits the field |
| 3 | **`src/core/config/loader.ts` — `mergeWithDefaults`** | Without this, the user's value is silently dropped between yaml-parse and command consumption. **TypeScript will not catch this** because the object literal in `mergeWithDefaults` simply omits the field, and the function still returns a valid `WtbConfig` thanks to `?: optional` typing. |
| 4 | `src/core/config/validator.ts` | Type / shape check; emits warning or throws (exit 4) |
| 5 | `src/core/config/loader.test.ts` | Regression test — assert that a user-supplied value survives `loadConfig` |

## The bug we shipped

Volume auto-clone added `volumes.exclude` to `WtbConfig`, plus the default in `constants/index.ts` and validation in `validator.ts`. We forgot **step 3**. The opt-out config option was completely non-functional in v0 of the feature — caught only by Codex P1 and Copilot inline review on PR #8.

The minimal repro:

```yaml
# wtb.yaml
volumes:
  exclude: [cache_data]
```

Pre-fix: wtb cloned `cache_data` anyway. Post-fix: it's correctly skipped.

## Why this is easy to miss

- `mergeWithDefaults` is a verbose object literal listing each field by hand (chosen historically because `??` is required for falsy-safe merging — spreading `{...DEFAULT_CONFIG, ...partial}` would let `partial.copy_files = []` get clobbered)
- Adding the type only flags missing fields if the function signature requires them; with optional fields, a literal can omit them silently
- Reviewers (and we) tend to scan `loader.ts` last, after type / default / validator are set up

## Mitigation

The unit test at `src/core/config/loader.test.ts > "should preserve user volumes.exclude through mergeWithDefaults"` is now the canary. Any future merge regression on `volumes.exclude` (or other fields with similar tests) will fail this test before review.

When adding new fields, write the regression test in step 5 before/while wiring step 3. The test reads naturally as the spec.

## Related: `??` vs `||`

The merger uses `partial.field ?? DEFAULT_CONFIG.field`. This matters for arrays:

- `partial.copy_files ?? [...]` — if user explicitly set `copy_files: []`, the explicit empty array survives
- `partial.copy_files || [...]` — would WRONGLY default empty arrays back to the example list

Don't change this to `||` "for consistency" with other code.
