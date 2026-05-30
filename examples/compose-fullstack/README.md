# compose-fullstack

The heaviest example — it exercises **every** wtb phase at once.

- **4-service Docker Compose stack**: `web` (nginx) → `api` (node) → `postgres` + `redis`, all prebuilt images (no Docker build needed).
- **Two named volumes** (`pg_data`, `redis_data`) that wtb clones into each new worktree, so a branch starts with main's DB + cache contents.
- **`node_modules` symlinked** (`link_files`) instead of copied.
- **Four ports auto-remapped** (`APP_PORT`, `API_PORT`, `DB_PORT`, `REDIS_PORT`) so multiple worktrees run in parallel without collisions.
- **Lifecycle scripts** (`start-dev.sh` / `stop-dev.sh`) bring the stack up/down.

## Try it

```bash
# from the wtb repo root — dry-run (no side effects):
examples/try.sh compose-fullstack feature/demo

# real run (needs Docker; creates a worktree + clones volumes):
examples/try.sh compose-fullstack feature/demo --real
```

What to look for: each port shifts to the next free value, `pg_data` / `redis_data` clone into the new project, and `wtb ports --pretty` lists the worktree's endpoints.
