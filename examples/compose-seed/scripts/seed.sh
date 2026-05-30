#!/usr/bin/env bash
# Invoked by `wtb create --seed` (via volumes.seed_command). Builds a fresh DB
# in this worktree instead of cloning main's data. Runs with cwd = worktree root.
set -euo pipefail

echo "▶ waiting for db to accept connections…"
for _ in $(seq 1 30); do
  if docker compose exec -T db pg_isready -U "${DB_USER:-app}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "▶ seeding a fresh schema"
docker compose exec -T db psql -U "${DB_USER:-app}" -d "${DB_NAME:-app_db}" <<'SQL'
CREATE TABLE IF NOT EXISTS fixtures (id serial PRIMARY KEY, label text NOT NULL);
INSERT INTO fixtures (label) VALUES ('freshly seeded — not a clone of main');
SQL
echo "▶ seed complete"
