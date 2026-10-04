#!/usr/bin/env bash
# Exercise Orca's existing-worktree lifecycle against a real PostgreSQL clone.
# Every Docker resource belongs to a fresh temp repository and unique run label.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT_DIR/dist/cli/index.js"
echo "Building current CLI for Orca lifecycle integration..."
( cd "$ROOT_DIR" && npm run build >/dev/null )

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: Docker is unavailable; Orca lifecycle integration was not executed."
  exit 0
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "SKIP: Docker Compose is unavailable; Orca lifecycle integration was not executed."
  exit 0
fi

# Do not let the caller's Compose overrides select a real user stack.
unset COMPOSE_PROJECT_NAME COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PROFILES
BASE="$(mktemp -d "${TMPDIR:-/tmp}/wtb-orca-int.XXXXXX")"
BASE="$(cd "$BASE" && pwd -P)"
RUN_ID="$(date +%s)-$$-${RANDOM}"
SOURCE_PROJECT="wtborca-$RUN_ID"
REPO="$BASE/repository"
WORKTREE="$BASE/orca-workspace"
COMPOSE_REL="ops/postgres.compose.yml"
BRANCH="feature/orca"
EXTERNAL_VOLUME="$SOURCE_PROJECT-external"
UNRELATED_VOLUME="$SOURCE_PROJECT-unrelated"
REPO_LABEL=""
OWN_RESOURCES=false
LAST_JSON=""
LAST_STDERR=""

pass() { echo "  PASS: $1"; }
fail() {
  echo "  FAIL: $1" >&2
  if [ -n "$LAST_STDERR" ] && [ -f "$LAST_STDERR" ]; then cat "$LAST_STDERR" >&2; fi
  if [ -n "$LAST_JSON" ] && [ -f "$LAST_JSON" ]; then cat "$LAST_JSON" >&2; fi
  exit 1
}

cleanup() {
  set +e
  if [ "$OWN_RESOURCES" = true ]; then
    for container in $(docker ps -aq --filter "label=wtb.integration.run=$RUN_ID" 2>/dev/null); do
      owner="$(docker inspect --format '{{index .Config.Labels "wtb.integration.run"}}' "$container" 2>/dev/null)"
      [ "$owner" = "$RUN_ID" ] && docker rm -f "$container" >/dev/null 2>&1
    done
    # Clone lease containers have repository labels, not fixture service labels.
    if [ -n "$REPO_LABEL" ]; then
      for container in $(docker ps -aq --filter "label=wtb.repo=$REPO_LABEL" 2>/dev/null); do
        owner="$(docker inspect --format '{{index .Config.Labels "wtb.repo"}}' "$container" 2>/dev/null)"
        [ "$owner" = "$REPO_LABEL" ] && docker rm -f "$container" >/dev/null 2>&1
      done
    fi
    for network in $(docker network ls -q --filter "label=wtb.integration.run=$RUN_ID" 2>/dev/null); do
      owner="$(docker network inspect --format '{{index .Labels "wtb.integration.run"}}' "$network" 2>/dev/null)"
      [ "$owner" = "$RUN_ID" ] && docker network rm "$network" >/dev/null 2>&1
    done
    for volume in $(docker volume ls -q 2>/dev/null); do
      case "$volume" in "$SOURCE_PROJECT"-*|"$SOURCE_PROJECT"_*) ;; *) continue ;; esac
      labels="$(docker volume inspect --format '{{json .Labels}}' "$volume" 2>/dev/null)"
      if node -e 'const x=JSON.parse(process.argv[1]||"null")||{}; process.exit(x["wtb.integration.run"]===process.argv[2] || (process.argv[3] && x["wtb.repo"]===process.argv[3]) ? 0 : 1)' "$labels" "$RUN_ID" "$REPO_LABEL"; then
        docker volume rm "$volume" >/dev/null 2>&1 || true
      else
        echo "  Leaving volume without exact test ownership: $volume" >&2
      fi
    done
  fi
  case "$BASE" in */wtb-orca-int.*) [ -d "$BASE" ] && rm -rf "$BASE" ;; esac
}
trap cleanup EXIT

# Abort before owning anything if the generated resource namespace already exists.
if docker volume ls --format '{{.Name}}' | grep -E "^${SOURCE_PROJECT}([-_]|$)" >/dev/null; then
  fail "unique volume prefix collision"
fi
if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$SOURCE_PROJECT")" ]; then
  fail "unique Compose project collision"
fi
if [ -n "$(docker network ls -q --filter "label=com.docker.compose.project=$SOURCE_PROJECT")" ]; then
  fail "unique Compose network collision"
fi
OWN_RESOURCES=true

run_json() {
  local label="$1"
  shift
  LAST_JSON="$BASE/$label.json"
  LAST_STDERR="$BASE/$label.stderr"
  set +e
  ( cd "$WORKTREE" && ORCA_WORKTREE_PATH="$WORKTREE" node "$CLI" "$@" --json >"$LAST_JSON" 2>"$LAST_STDERR" )
  LAST_STATUS=$?
  set -e
  node - "$LAST_JSON" <<'NODE'
const fs = require("node:fs")
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected exactly one JSON object")
NODE
}

container_id() {
  docker ps -q --filter "label=com.docker.compose.project=$1" --filter "label=com.docker.compose.service=db"
}
sql() { docker exec "$1" psql -U postgres -d app -v ON_ERROR_STOP=1 -Atc "$2"; }
marker() {
  docker run --rm --label "wtb.integration.run=$RUN_ID" --entrypoint sh \
    -v "$1:/fixture:ro" postgres:16-alpine -c 'cat /fixture/marker'
}

mkdir -p "$REPO/ops"
cat > "$REPO/$COMPOSE_REL" <<YAML
name: $SOURCE_PROJECT
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: test-only-password
      POSTGRES_DB: app
    labels:
      wtb.integration.run: "$RUN_ID"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d app"]
      interval: 1s
      timeout: 3s
      retries: 30
    volumes:
      - data:/var/lib/postgresql/data
      - shared:/shared:ro
volumes:
  data:
    labels:
      wtb.integration.run: "$RUN_ID"
  shared:
    external: true
    name: $EXTERNAL_VOLUME
networks:
  default:
    labels:
      wtb.integration.run: "$RUN_ID"
YAML
cat > "$REPO/wtb.yaml" <<YAML
base_branch: main
docker_compose_file: $COMPOSE_REL
copy_files: []
link_files: []
env:
  file: []
  adjust: {}
start_command: printf 'start\n' >> .starts
end_command: printf 'archive\n' >> .archives
YAML
printf '.starts\n.archives\n' > "$REPO/.gitignore"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.name "wtb Orca integration"
git -C "$REPO" config user.email integration@example.invalid
git -C "$REPO" add -A
git -C "$REPO" commit -qm fixture
REPO_LABEL="$(node --input-type=module - "$ROOT_DIR" "$REPO" <<'NODE'
import path from "node:path"
import { pathToFileURL } from "node:url"
const { repoVolumeLabel } = await import(pathToFileURL(path.join(process.argv[2], "dist/core/docker/volume.js")))
process.stdout.write(repoVolumeLabel(process.argv[3]))
NODE
)"

docker volume create --label "wtb.integration.run=$RUN_ID" "$EXTERNAL_VOLUME" >/dev/null
docker volume create --label "wtb.integration.run=$RUN_ID" --label wtb.managed=true \
  --label "wtb.repo=foreign-$RUN_ID" --label "wtb.project=foreign-$RUN_ID" --label wtb.branch=unrelated \
  "$UNRELATED_VOLUME" >/dev/null
for volume in "$EXTERNAL_VOLUME" "$UNRELATED_VOLUME"; do
  docker run --rm --label "wtb.integration.run=$RUN_ID" --entrypoint sh \
    -v "$volume:/fixture" postgres:16-alpine -c 'printf "%s" "$1" > /fixture/marker' sh "$volume" >/dev/null
done

echo "Real-Docker Orca lifecycle integration ($RUN_ID)"
( cd "$REPO" && docker compose -f "$COMPOSE_REL" -p "$SOURCE_PROJECT" up -d --wait --wait-timeout 60 >/dev/null )
SOURCE_CONTAINER="$(container_id "$SOURCE_PROJECT")"
[ -n "$SOURCE_CONTAINER" ] || fail "source PostgreSQL container missing"
sql "$SOURCE_CONTAINER" "CREATE TABLE wtb_probe (id integer primary key, value text not null); INSERT INTO wtb_probe VALUES (1, '$RUN_ID');" >/dev/null
SOURCE_VOLUME="$(docker volume ls -q --filter "label=com.docker.compose.project=$SOURCE_PROJECT" --filter label=com.docker.compose.volume=data)"
[ -n "$SOURCE_VOLUME" ] || fail "source volume missing"

# Orca creates the checkout first; wtb must neither create nor replace it.
git -C "$REPO" worktree add -q -b "$BRANCH" "$WORKTREE"
HEAD_BEFORE="$(git -C "$WORKTREE" rev-parse HEAD)"
run_json setup setup --up --wait --timeout 60
[ "$LAST_STATUS" -eq 0 ] || fail "setup exited $LAST_STATUS"
TARGET_PROJECT="$(node - "$LAST_JSON" <<'NODE'
const fs = require("node:fs")
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
if (!value.ok || !value.prepared || value.reused || !value.up?.ok || !value.readiness?.ok || value.setup?.volumeResult?.cloned?.length !== 1) {
  throw new Error(`setup did not clone/start/await: ${JSON.stringify(value)}`)
}
process.stdout.write(value.readiness.project)
NODE
)"
case "$TARGET_PROJECT" in "$SOURCE_PROJECT"-*) ;; *) fail "unexpected target project '$TARGET_PROJECT'" ;; esac
TARGET_CONTAINER="$(container_id "$TARGET_PROJECT")"
[ -n "$TARGET_CONTAINER" ] || fail "target PostgreSQL container missing"
[ "$(sql "$TARGET_CONTAINER" 'SELECT value FROM wtb_probe WHERE id=1')" = "$RUN_ID" ] || fail "source database record was not cloned"
sql "$TARGET_CONTAINER" "INSERT INTO wtb_probe VALUES (2, 'target-only');" >/dev/null
SOURCE_CONTAINER="$(container_id "$SOURCE_PROJECT")"
[ "$(sql "$SOURCE_CONTAINER" 'SELECT count(*) FROM wtb_probe')" = 1 ] || fail "target writes modified source data"
[ "$(git -C "$WORKTREE" rev-parse HEAD)" = "$HEAD_BEFORE" ] || fail "setup changed checkout HEAD"
TARGET_VOLUME="$(docker volume ls -q --filter "label=wtb.repo=$REPO_LABEL" --filter "label=wtb.project=$TARGET_PROJECT" --filter "label=wtb.branch=$BRANCH")"
[ -n "$TARGET_VOLUME" ] || fail "owned target volume missing"
docker volume inspect --format '{{json .Labels}}' "$TARGET_VOLUME" | node -e '
let input=""; process.stdin.on("data", c => input+=c); process.stdin.on("end", () => {
  const labels=JSON.parse(input), [repo,project,branch]=process.argv.slice(1);
  if(labels["wtb.managed"]!=="true" || labels["wtb.repo"]!==repo || labels["wtb.project"]!==project || labels["wtb.branch"]!==branch) throw new Error("target ownership mismatch");
});' "$REPO_LABEL" "$TARGET_PROJECT" "$BRANCH"
pass "existing Orca checkout received an isolated, healthy clone; source writes remain isolated"

# A completed maintenance one-off is not a running service replica.
ONEOFF_NAME="$SOURCE_PROJECT-oneoff"
( cd "$WORKTREE" && docker compose -f "$COMPOSE_REL" -p "$TARGET_PROJECT" run --no-deps -T --name "$ONEOFF_NAME" db true >/dev/null )
run_json oneoff-await await --timeout 15
[ "$LAST_STATUS" -eq 0 ] || fail "completed one-off incorrectly blocked readiness"
[ "$(docker inspect --format '{{index .Config.Labels "wtb.integration.run"}}' "$ONEOFF_NAME")" = "$RUN_ID" ] || fail "one-off cleanup ownership mismatch"
docker rm "$ONEOFF_NAME" >/dev/null
pass "readiness excludes completed Compose run one-offs"

( cd "$WORKTREE" && docker compose -f "$COMPOSE_REL" -p "$TARGET_PROJECT" stop db >/dev/null )
run_json timeout await --timeout 2
[ "$LAST_STATUS" -eq 1 ] || fail "stopped target should time out with exit 1"
node - "$LAST_JSON" <<'NODE'
const fs=require("node:fs"), value=JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if(value.ok!==false || value.timedOut!==true || !value.services.some(service => !service.ready)) throw new Error("missing timeout diagnostics");
NODE
run_json reuse setup --up --wait --timeout 60
[ "$LAST_STATUS" -eq 0 ] || fail "setup readiness retry failed"
node - "$LAST_JSON" <<'NODE'
const fs=require("node:fs"), value=JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if(!value.ok || !value.reused || value.setup!==null || !value.readiness?.ok) throw new Error("setup replayed environment preparation");
NODE
[ "$(wc -l < "$WORKTREE/.starts" | tr -d ' ')" = 1 ] || fail "start_command ran more than once"
TARGET_CONTAINER="$(container_id "$TARGET_PROJECT")"
[ "$(sql "$TARGET_CONTAINER" 'SELECT count(*) FROM wtb_probe')" = 2 ] || fail "setup reuse recloned or lost target data"
pass "readiness timeout is actionable; setup retries startup without replaying start/data phases"

run_json teardown teardown --remove-volumes
[ "$LAST_STATUS" -eq 0 ] || fail "teardown exited $LAST_STATUS"
node - "$LAST_JSON" <<'NODE'
const fs=require("node:fs"), value=JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if(!value.ok || !value.tornDown || value.removed!==false || !value.composeDown?.volumesRemoved || !value.endCommand?.ran) throw new Error("incomplete teardown result");
NODE
[ -d "$WORKTREE" ] && [ "$(git -C "$WORKTREE" rev-parse HEAD)" = "$HEAD_BEFORE" ] || fail "archive cleanup removed/replaced the checkout"
[ "$(git -C "$WORKTREE" branch --show-current)" = "$BRANCH" ] || fail "archive cleanup changed the branch"
[ "$(wc -l < "$WORKTREE/.archives" | tr -d ' ')" = 1 ] || fail "end_command did not run once"
if docker volume inspect "$TARGET_VOLUME" >/dev/null 2>&1; then fail "teardown retained the owned target volume"; fi
docker volume inspect "$SOURCE_VOLUME" >/dev/null || fail "teardown removed the source volume"
[ "$(marker "$EXTERNAL_VOLUME")" = "$EXTERNAL_VOLUME" ] || fail "teardown changed external volume data"
[ "$(marker "$UNRELATED_VOLUME")" = "$UNRELATED_VOLUME" ] || fail "teardown changed unrelated foreign volume data"
[ "$(sql "$SOURCE_CONTAINER" 'SELECT count(*) FROM wtb_probe')" = 1 ] || fail "teardown damaged the source database"
pass "archive teardown deleted only target-owned data and preserved Git, source, external and foreign data"
echo "PASS: real-Docker Orca lifecycle integration completed."
