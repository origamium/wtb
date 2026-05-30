# node-no-docker

Everything wtb does **except Docker**. `docker_compose_file` is omitted, so the
Compose + volume phases are skipped entirely — but you still get:

- **`copy_files`** — `.env`, `.env.local` copied into each worktree.
- **`link_files`** — `node_modules` symlinked (one source of truth).
- **`env.adjust`** — all three value types: numbers (`PORT`, `WS_PORT`) bump to free ports, a string (`LOG_LEVEL`) is replaced verbatim, and `null` (`DEPRECATED_FLAG`) removes the key.
- **`start_command`** — `npm run setup` runs in the new worktree.

`.env.local` also includes a quoted value with `#` inside it
(`postgres://app:p@ss#word@…`) as a regression smoke test — wtb keeps it intact.

## Try it

```bash
examples/try.sh node-no-docker feature/demo            # dry-run
examples/try.sh node-no-docker feature/demo --real     # real (no Docker needed)
```
