# compose-identity

The Supabase-collision case: a compose file with a **fixed identity** — top-level
`name: acme`, per-service `container_name:`, and a literal `8080` host port.

## Without wtb

Run `docker compose up` from a second checkout of this project and:

- both checkouts resolve to the same Compose project `acme`, so the second `up`
  **hijacks** the first stack (recreates its containers from the other checkout's
  files) instead of starting a second one;
- the fixed `container_name: acme_api` / `acme_db` already exist, so the second
  `up` **refuses to start**;
- the literal host port `8080` is already bound — **port conflict**.

## With wtb

`wtb create` rewrites the worktree's compose copy so each worktree is its own stack:

- `name: acme` → `acme-<branch-slug>`
- `container_name: acme_api` → `acme_api-<branch-slug>` (same for `acme_db`)
- `DB_PORT` bumped to the next free port in the copied `.env` and propagated into
  the compose `${DB_PORT:-54322}` default
- the literal `8080` host port remapped to a free one, with the port change
  reflected in `API_URL=http://localhost:8080`

`wtb doctor` surfaces exactly these findings (fixed `name:`/`container_name:`,
literal host ports) before you create anything.

## Try it

```bash
examples/try.sh compose-identity feature/demo            # dry-run
examples/try.sh compose-identity feature/demo --real     # real (needs Docker)
```
