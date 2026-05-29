# Suggested Commands for wtb Development

## Development

```bash
npm run dev          # tsx — run from source
npm run build        # tsc → dist/
npm start            # node dist/index.js (library entry; not the CLI)
npm run clean        # rm -rf dist
```

## Code Quality

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # biome lint src/ e2e/
npm run format       # biome format --write src/ e2e/
npm run check        # biome check --write (lint + format together)
```

## Tests

```bash
npm test             # vitest (watch mode)
npm run test:run     # vitest run (one shot, both src and e2e)
npm run test:unit    # vitest run src/   (only colocated unit tests)
npm run test:e2e     # vitest run e2e/   (creates real git repos)
npm run test:ui      # vitest --ui
```

`prepublishOnly` is `clean && build && test:run` so a red test cannot ship to npm.

## CLI Usage

The CLI binary is at `dist/cli/index.js` (note: **not** `dist/index.js` — that is the library entry).

```bash
# After build
node dist/cli/index.js --help
node dist/cli/index.js --version

# Common flows
node dist/cli/index.js create feature/x [--no-docker] [--dry-run] [--no-volume-copy]
node dist/cli/index.js remove feature/x [--force] [--remove-volumes]
node dist/cli/index.js ls [-l] [--json] [-p]
node dist/cli/index.js ports [--all] [--pretty]
node dist/cli/index.js status [-a] [--docker-only]
node dist/cli/index.js init-claude [--user] [--force] [--dry-run]

# Globally installed
wtb create feature/x
```

## Sample / Manual Testing

A runnable Postgres + Next.js + Debian playground lives in `sample/`.

```bash
cd sample
node ../dist/cli/index.js create test-branch
node ../dist/cli/index.js ports --pretty   # see remapped ports
node ../dist/cli/index.js ls -l
node ../dist/cli/index.js remove test-branch
```

## Manual end-to-end of volume clone (real Docker required)

```bash
# Set up Compose project with a named volume
TMP=$(mktemp -d) && cd "$TMP"
git init -q && git config user.email t@t && git config user.name t
echo x > README.md && git add . && git commit -q -m i
cat > docker-compose.yml <<'YAML'
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: dev
      POSTGRES_DB: app
    volumes:
      - postgres_data:/var/lib/postgresql/data
volumes:
  postgres_data:
YAML
cat > wtb.yaml <<'YAML'
base_branch: main
docker_compose_file: ./docker-compose.yml
copy_files: []
link_files: []
env: { file: ["./.env"], adjust: { PORT: 1 } }
YAML
echo PORT=5432 > .env && git add . && git commit -q -m c

# Write data on the source side, then stop
docker compose up -d && sleep 5
docker exec $(docker compose ps -q db) psql -U postgres -d app \
  -c "CREATE TABLE foo(id serial, msg text); INSERT INTO foo(msg) VALUES ('main');"
docker compose down

# Clone via wtb
node /path/to/wtb/dist/cli/index.js create feat/x

# Verify carry-over
cd "../worktree-feat-x"
docker compose up -d && sleep 5
docker exec $(docker compose ps -q db) psql -U postgres -d app -c "SELECT * FROM foo;"
# expected: id=1 msg='main'
```

## Verifying Compose's actual project name

When debugging volume-clone naming, compare what Compose computes to what `resolveComposeProjectName` returns:

```bash
cd <worktree>
docker compose config --format json | jq -r '.name'
```

Should match the value wtb uses for the `<project>_<volume>` prefix.
