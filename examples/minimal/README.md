# minimal

The smallest useful config: **no Docker, no symlinks, no scripts.** wtb just copies
`.env` into each new worktree and bumps `PORT` so two worktrees don't collide.

This is the baseline for "I only want isolated checkouts that each have their own
port" — the rest of wtb's features are opt-in.

## Try it

```bash
examples/try.sh minimal feature/demo            # dry-run
examples/try.sh minimal feature/demo --real     # real (no Docker needed)
```
