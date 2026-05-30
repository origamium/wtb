# compose-seed

Shows the three ways wtb deliberately does **not** just clone every volume:

1. **`volumes.exclude`** — `cache_data` (redis) is regenerable, so it's never cloned.
2. **`external: true`** — `shared_assets` is shared across worktrees, so wtb skips it automatically.
3. **`volumes.seed_command`** — `wtb create --seed` builds a **fresh** DB in the new worktree (via `scripts/seed.sh`) instead of copying main's. Because nothing is read off a live source volume, this path never stops the source stack.

## Try it

```bash
# default create: clones db_data, skips cache_data (excluded) + shared_assets (external)
examples/try.sh compose-seed feature/clone

# seed instead of clone: fresh DB, source stack untouched (needs Docker)
examples/try.sh compose-seed feature/fresh --real --seed
```
