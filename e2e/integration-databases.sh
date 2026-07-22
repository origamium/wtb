#!/usr/bin/env bash
#
# Real-Docker integration checks for database volume cloning and host-port
# collision avoidance. This intentionally uses actual PostgreSQL/MySQL servers
# so the copied volume is proven bootable by the target service.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT_DIR/dist/cli/index.js"

echo "Building current CLI for database integration..."
( cd "$ROOT_DIR" && npm run build >/dev/null )

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "⏭  Docker is not available — skipping database integration test (this is fine in CI)."
  exit 0
fi

BASE="$(mktemp -d "${TMPDIR:-/tmp}/wtb-db-int.XXXXXX")"
RUN_ID="$(date +%s)-$$-${RANDOM}"
RESOURCE_PREFIX="wtbdb-${RUN_ID}"
TRACKED_PROJECTS=""

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; exit 1; }

remember_project() {
  case " $TRACKED_PROJECTS " in
    *" $1 "*) ;;
    *) TRACKED_PROJECTS="$TRACKED_PROJECTS $1" ;;
  esac
}

cleanup() {
  set +e
  for project in $TRACKED_PROJECTS; do
    for container in $(docker ps -aq --filter "label=com.docker.compose.project=$project" 2>/dev/null); do
      docker rm -f "$container" >/dev/null 2>&1 || true
    done
    for network in $(docker network ls -q --filter "label=com.docker.compose.project=$project" 2>/dev/null); do
      docker network rm "$network" >/dev/null 2>&1 || true
    done
  done
  for volume in $(docker volume ls -q 2>/dev/null | grep -E "^${RESOURCE_PREFIX}[-_]" || true); do
    docker volume rm -f "$volume" >/dev/null 2>&1 || true
  done
  [ -n "$BASE" ] && [ -d "$BASE" ] && rm -rf "$BASE"
}
trap cleanup EXIT

wait_for() {
  local description="$1"
  shift
  for _ in $(seq 1 90); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "timed out waiting for $description"
}

container_id() {
  local project="$1"
  docker ps -q \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=db" |
    sed '/^$/d' |
    head -n 1
}

target_project_from_create_json() {
  node - "$1" <<'NODE'
const fs = require("node:fs")
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
const project = value.composeIdentity?.projectName?.to
if (typeof project !== "string" || project.length === 0) {
  throw new Error(`create JSON did not contain target Compose project: ${JSON.stringify(value)}`)
}
process.stdout.write(project)
NODE
}

run_json() {
  local repo="$1" label="$2"
  shift 2
  LAST_JSON="$BASE/$label.json"
  LAST_STDERR="$BASE/$label.stderr"
  set +e
  ( cd "$repo" && node "$CLI" "$@" --json >"$LAST_JSON" 2>"$LAST_STDERR" )
  LAST_STATUS=$?
  set -e
  node - "$LAST_JSON" <<'NODE'
const fs = require("node:fs")
const text = fs.readFileSync(process.argv[2], "utf8").trim()
if (!text) throw new Error("JSON stdout was empty")
const value = JSON.parse(text)
if (value === null || Array.isArray(value) || typeof value !== "object") {
  throw new Error("stdout was not exactly one JSON object")
}
NODE
}

init_repo() {
  local repo="$1"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.email integ@test.local
  git -C "$repo" config user.name "wtb database integration"
  git -C "$repo" add -A
  git -C "$repo" commit -qm init
}

free_port() {
  node <<'NODE'
const net = require("node:net")
const server = net.createServer()
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port))
  server.close()
})
NODE
}

run_port_collision_check() {
  local repo="$BASE/port-repository"
  local compose_rel="ops/ports.compose.yml"
  local source_project="${RESOURCE_PREFIX}-ports"
  local branch="feat/ports"
  local source_port
  source_port="$(free_port)"
  mkdir -p "$repo/ops"
  cat > "$repo/$compose_rel" <<YAML
name: $source_project
services:
  web:
    image: busybox
    command: sh -c 'mkdir -p /www && printf ok > /www/index.html && httpd -f -p 80 -h /www'
    ports:
      - "$source_port:80"
YAML
  cat > "$repo/wtb.yaml" <<YAML
base_branch: main
docker_compose_file: ./$compose_rel
env:
  file: []
  adjust: {}
YAML
  init_repo "$repo"
  remember_project "$source_project"

  ( cd "$repo" && docker compose -f "$compose_rel" -p "$source_project" up -d >/dev/null )
  wait_for "source web on $source_port" docker ps -q --filter "label=com.docker.compose.project=$source_project" --filter status=running

  run_json "$repo" create-ports create "$branch" --path "$BASE/worktree-ports"
  [ "$LAST_STATUS" -eq 0 ] || fail "port create failed: $(cat "$LAST_STDERR")"
  local target_project
  target_project="$(target_project_from_create_json "$LAST_JSON")"
  remember_project "$target_project"
  node - "$LAST_JSON" "$source_port" <<'NODE'
const fs = require("node:fs")
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
const sourcePort = Number(process.argv[3])
const change = value.composePorts?.web?.[0]
if (!change || change.from !== sourcePort || change.to === sourcePort) {
  throw new Error(`expected web port remap away from ${sourcePort}: ${JSON.stringify(value.composePorts)}`)
}
NODE

  run_json "$repo" up-ports up "$branch"
  [ "$LAST_STATUS" -eq 0 ] || fail "port up failed: $(cat "$LAST_STDERR")"
  local target_web
  target_web="$(docker ps -q --filter "label=com.docker.compose.project=$target_project" --filter "label=com.docker.compose.service=web")"
  [ -n "$target_web" ] || fail "target web service did not start"
  local published
  published="$(docker port "$target_web" 80/tcp | sed 's/.*://')"
  [ -n "$published" ] || fail "target web service has no published port"
  [ "$published" != "$source_port" ] || fail "target reused source host port $source_port"
  [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$source_project" --filter status=running)" ] || \
    fail "source web stopped during target up"

  run_json "$repo" down-ports down "$branch"
  [ "$LAST_STATUS" -eq 0 ] || fail "port down failed: $(cat "$LAST_STDERR")"
  pass "target Compose starts while source host port remains occupied"
}

run_postgres_clone_check() {
  local repo="$BASE/postgres-repository"
  local compose_rel="ops/postgres.compose.yml"
  local source_project="${RESOURCE_PREFIX}-postgres"
  local branch="feat/postgres"
  local marker="postgres-$RUN_ID"
  mkdir -p "$repo/ops"
  cat > "$repo/$compose_rel" <<YAML
name: $source_project
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: wtbpass
      POSTGRES_DB: app
    volumes:
      - data:/var/lib/postgresql/data
volumes:
  data:
YAML
  cat > "$repo/wtb.yaml" <<YAML
base_branch: main
docker_compose_file: ./$compose_rel
env:
  file: []
  adjust: {}
YAML
  init_repo "$repo"
  remember_project "$source_project"

  ( cd "$repo" && docker compose -f "$compose_rel" -p "$source_project" up -d >/dev/null )
  local source_container
  source_container="$(container_id "$source_project")"
  [ -n "$source_container" ] || fail "postgres source container not found"
  wait_for "postgres source readiness" docker exec "$source_container" pg_isready -U postgres -d app
  docker exec "$source_container" psql -U postgres -d app -v ON_ERROR_STOP=1 \
    -c "CREATE TABLE wtb_probe (id integer primary key, value text not null); INSERT INTO wtb_probe VALUES (1, '$marker');" >/dev/null

  run_json "$repo" create-postgres create "$branch" --path "$BASE/worktree-postgres"
  [ "$LAST_STATUS" -eq 0 ] || fail "postgres create failed: $(cat "$LAST_STDERR")"
  local target_project
  target_project="$(target_project_from_create_json "$LAST_JSON")"
  remember_project "$target_project"

  run_json "$repo" up-postgres up "$branch"
  [ "$LAST_STATUS" -eq 0 ] || fail "postgres up failed: $(cat "$LAST_STDERR")"
  local target_container
  target_container="$(container_id "$target_project")"
  [ -n "$target_container" ] || fail "postgres target container not found"
  wait_for "postgres target readiness" docker exec "$target_container" pg_isready -U postgres -d app
  local copied
  copied="$(docker exec "$target_container" psql -U postgres -d app -At -c "SELECT value FROM wtb_probe WHERE id=1")"
  [ "$copied" = "$marker" ] || fail "postgres copied value mismatch: $copied"

  run_json "$repo" down-postgres down "$branch"
  [ "$LAST_STATUS" -eq 0 ] || fail "postgres down failed: $(cat "$LAST_STDERR")"
  pass "PostgreSQL volume clone boots with copied table data"
}

run_mysql_clone_check() {
  local repo="$BASE/mysql-repository"
  local compose_rel="ops/mysql.compose.yml"
  local source_project="${RESOURCE_PREFIX}-mysql"
  local branch="feat/mysql"
  local marker="mysql-$RUN_ID"
  mkdir -p "$repo/ops"
  cat > "$repo/$compose_rel" <<YAML
name: $source_project
services:
  db:
    image: mysql:latest
    environment:
      MYSQL_ROOT_PASSWORD: wtbpass
      MYSQL_DATABASE: app
    volumes:
      - data:/var/lib/mysql
volumes:
  data:
YAML
  cat > "$repo/wtb.yaml" <<YAML
base_branch: main
docker_compose_file: ./$compose_rel
env:
  file: []
  adjust: {}
YAML
  init_repo "$repo"
  remember_project "$source_project"

  ( cd "$repo" && docker compose -f "$compose_rel" -p "$source_project" up -d >/dev/null )
  local source_container
  source_container="$(container_id "$source_project")"
  [ -n "$source_container" ] || fail "mysql source container not found"
  wait_for "mysql source readiness" docker exec "$source_container" mysql -uroot -pwtbpass -e "SELECT 1"
  docker exec "$source_container" mysql -uroot -pwtbpass app \
    -e "CREATE TABLE wtb_probe (id INT PRIMARY KEY, value VARCHAR(128) NOT NULL); INSERT INTO wtb_probe VALUES (1, '$marker');" >/dev/null

  run_json "$repo" create-mysql create "$branch" --path "$BASE/worktree-mysql"
  [ "$LAST_STATUS" -eq 0 ] || fail "mysql create failed: $(cat "$LAST_STDERR")"
  local target_project
  target_project="$(target_project_from_create_json "$LAST_JSON")"
  remember_project "$target_project"

  run_json "$repo" up-mysql up "$branch"
  [ "$LAST_STATUS" -eq 0 ] || fail "mysql up failed: $(cat "$LAST_STDERR")"
  local target_container
  target_container="$(container_id "$target_project")"
  [ -n "$target_container" ] || fail "mysql target container not found"
  wait_for "mysql target readiness" docker exec "$target_container" mysql -uroot -pwtbpass -e "SELECT 1"
  local copied
  copied="$(docker exec "$target_container" mysql -N -B -uroot -pwtbpass app -e "SELECT value FROM wtb_probe WHERE id=1")"
  [ "$copied" = "$marker" ] || fail "mysql copied value mismatch: $copied"

  run_json "$repo" down-mysql down "$branch"
  [ "$LAST_STATUS" -eq 0 ] || fail "mysql down failed: $(cat "$LAST_STDERR")"
  pass "MySQL volume clone boots with copied table data"
}

echo "🔬 wtb database/port real-Docker integration test ($RUN_ID)"
run_port_collision_check
run_postgres_clone_check
run_mysql_clone_check
echo "🎉 Database and port integration checks passed."
