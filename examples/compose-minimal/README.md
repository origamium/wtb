# compose-minimal

The smallest real Docker case: **one Postgres service, one named volume, one port.**

Good for seeing the core data-isolation guarantee on its own — when the source DB
is running, wtb stops it, clones `db_data`, and restarts it (stop-then-copy), so the
new worktree starts with an exact copy of main's database.

## Try it

```bash
examples/try.sh compose-minimal feature/demo            # dry-run
examples/try.sh compose-minimal feature/demo --real     # real (needs Docker)
```
