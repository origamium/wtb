#!/usr/bin/env bash
#
# Real-Docker integration test for wtb's volume ownership, clone/recovery, and
# prune safety contracts. Unit tests mock the Docker boundary; this script uses
# a live daemon and deliberately exercises the destructive paths with resources
# unique to this run.
#
# Run manually with: npm run test:integration
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT_DIR/dist/cli/index.js"

# Always test the current sources. A stale dist previously let this integration
# suite validate old volume naming/ownership behavior.
echo "Building current CLI..."
( cd "$ROOT_DIR" && npm run build >/dev/null )

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "⏭  Docker is not available — skipping integration test (this is fine in CI)."
  exit 0
fi

BASE="$(mktemp -d "${TMPDIR:-/tmp}/wtb-int.XXXXXX")"
RUN_ID="$(date +%s)-$$-${RANDOM}"
SOURCE_PROJECT="wtbint-${RUN_ID}"
PROJ="$BASE/repository"
COMPOSE_REL="ops/integration.compose.yml"
COMPOSE_FILE="$PROJ/$COMPOSE_REL"
REPO_LABEL=""
SOURCE_VOL=""
TRACKED_PROJECTS=""
MANUAL_VOLUMES=""

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; exit 1; }

remember_project() {
  case " $TRACKED_PROJECTS " in
    *" $1 "*) ;;
    *) TRACKED_PROJECTS="$TRACKED_PROJECTS $1" ;;
  esac
}

remember_manual_volume() {
  case " $MANUAL_VOLUMES " in
    *" $1 "*) ;;
    *) MANUAL_VOLUMES="$MANUAL_VOLUMES $1" ;;
  esac
}

volume_label() {
  docker volume inspect "$1" 2>/dev/null | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk });
    process.stdin.on("end", () => {
      const inspection = JSON.parse(input)[0];
      process.stdout.write(inspection.Labels?.[process.argv[1]] ?? "");
    });
  ' "$2"
}

is_manual_volume() {
  case " $MANUAL_VOLUMES " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

# Cleanup is deliberately fail-safe. A name must belong to this run's unique
# prefix and must additionally be either explicitly created by this script,
# owned by this repository label, or owned by the source Compose project.
safe_remove_volume() {
  local volume="$1"
  docker volume inspect "$volume" >/dev/null 2>&1 || return 0
  case "$volume" in
    "$SOURCE_PROJECT"_*|"$SOURCE_PROJECT"-*) ;;
    *)
      echo "  ⚠️  Refusing cleanup of unexpected volume name: $volume" >&2
      return 0
      ;;
  esac

  local repo_owner compose_owner
  repo_owner="$(volume_label "$volume" "wtb.repo" 2>/dev/null || true)"
  compose_owner="$(volume_label "$volume" "com.docker.compose.project" 2>/dev/null || true)"
  if is_manual_volume "$volume" || \
     { [ -n "$REPO_LABEL" ] && [ "$repo_owner" = "$REPO_LABEL" ]; } || \
     [ "$compose_owner" = "$SOURCE_PROJECT" ]; then
    docker volume rm -f "$volume" >/dev/null 2>&1 || true
  else
    echo "  ⚠️  Leaving volume with unverified ownership: $volume" >&2
  fi
}

cleanup() {
  set +e

  if [ -f "$COMPOSE_FILE" ]; then
    ( cd "$PROJ" && docker compose -f "$COMPOSE_REL" -p "$SOURCE_PROJECT" down >/dev/null 2>&1 ) || true
  fi

  # Remove only containers whose exact run/repository labels we can prove.
  for container in $(docker ps -aq --filter "label=wtb.integration.run=$RUN_ID" 2>/dev/null); do
    owner="$(docker inspect --format '{{with .Config.Labels}}{{index . "wtb.integration.run"}}{{end}}' "$container" 2>/dev/null)"
    [ "$owner" = "$RUN_ID" ] && docker rm -f "$container" >/dev/null 2>&1
  done
  if [ -n "$REPO_LABEL" ]; then
    for container in $(docker ps -aq --filter "label=wtb.repo=$REPO_LABEL" 2>/dev/null); do
      owner="$(docker inspect --format '{{with .Config.Labels}}{{index . "wtb.repo"}}{{end}}' "$container" 2>/dev/null)"
      [ "$owner" = "$REPO_LABEL" ] && docker rm -f "$container" >/dev/null 2>&1
    done
  fi
  for project in "$SOURCE_PROJECT" $TRACKED_PROJECTS; do
    [ -n "$project" ] || continue
    case "$project" in
      "$SOURCE_PROJECT"|"$SOURCE_PROJECT"-*) ;;
      *) continue ;;
    esac
    for container in $(docker ps -aq --filter "label=com.docker.compose.project=$project" 2>/dev/null); do
      owner="$(docker inspect --format '{{with .Config.Labels}}{{index . "com.docker.compose.project"}}{{end}}' "$container" 2>/dev/null)"
      [ "$owner" = "$project" ] && docker rm -f "$container" >/dev/null 2>&1
    done
    for network in $(docker network ls -q --filter "label=com.docker.compose.project=$project" 2>/dev/null); do
      owner="$(docker network inspect --format '{{with .Labels}}{{index . "com.docker.compose.project"}}{{end}}' "$network" 2>/dev/null)"
      [ "$owner" = "$project" ] && docker network rm "$network" >/dev/null 2>&1
    done
  done

  # Repository-owned temp/target volumes, plus the explicitly-created fixtures.
  if [ -n "$REPO_LABEL" ]; then
    for volume in $(docker volume ls -q --filter "label=wtb.repo=$REPO_LABEL" 2>/dev/null); do
      safe_remove_volume "$volume"
    done
  fi
  for volume in $MANUAL_VOLUMES; do
    safe_remove_volume "$volume"
  done
  if [ -n "$SOURCE_VOL" ]; then
    safe_remove_volume "$SOURCE_VOL"
  fi

  if [ -d "$PROJ/.git" ]; then
    git -C "$PROJ" worktree list --porcelain 2>/dev/null | while IFS= read -r line; do
      case "$line" in
        "worktree "*)
          worktree_path="${line#worktree }"
          case "$worktree_path" in
            "$BASE"/*)
              [ "$worktree_path" = "$PROJ" ] || \
                git -C "$PROJ" worktree remove --force "$worktree_path" >/dev/null 2>&1 || true
              ;;
          esac
          ;;
      esac
    done
  fi

  [ -n "$BASE" ] && [ -d "$BASE" ] && rm -rf "$BASE"
}
trap cleanup EXIT

assert_json_object() {
  node - "$1" <<'NODE'
const fs = require("node:fs")
const text = fs.readFileSync(process.argv[2], "utf8").trim()
if (!text) throw new Error("JSON stdout was empty")
const value = JSON.parse(text)
if (value === null || Array.isArray(value) || typeof value !== "object") {
  throw new Error("stdout was not exactly one JSON object")
}
NODE
}

run_json() {
  local label="$1"
  shift
  LAST_JSON="$BASE/$label.json"
  LAST_STDERR="$BASE/$label.stderr"
  set +e
  ( cd "$PROJ" && node "$CLI" "$@" --json >"$LAST_JSON" 2>"$LAST_STDERR" )
  LAST_STATUS=$?
  set -e
  assert_json_object "$LAST_JSON"
}

assert_volume_exists() {
  docker volume inspect "$1" >/dev/null 2>&1 || fail "expected volume '$1' to exist"
}

assert_volume_absent() {
  if docker volume inspect "$1" >/dev/null 2>&1; then
    fail "expected volume '$1' to be absent"
  fi
}

volume_set_marker() {
  assert_volume_exists "$1"
  docker run --rm --label "wtb.integration.run=$RUN_ID" -v "$1:/data" busybox \
    sh -c 'printf "%s\n" "$1" > /data/marker.txt' sh "$2" >/dev/null
}

volume_read_marker() {
  assert_volume_exists "$1"
  docker run --rm --label "wtb.integration.run=$RUN_ID" -v "$1:/data:ro" busybox \
    cat /data/marker.txt
}

volume_add_stale_file() {
  assert_volume_exists "$1"
  docker run --rm --label "wtb.integration.run=$RUN_ID" -v "$1:/data" busybox \
    sh -c 'printf stale > /data/stale-only.txt' >/dev/null
}

volume_has_file() {
  assert_volume_exists "$1"
  docker run --rm --label "wtb.integration.run=$RUN_ID" -v "$1:/data:ro" busybox \
    test -e "/data/$2"
}

volume_is_empty() {
  assert_volume_exists "$1"
  [ -z "$(docker run --rm --label "wtb.integration.run=$RUN_ID" -v "$1:/data:ro" busybox sh -c 'ls -A /data')" ]
}

assert_volume_ownership() {
  local volume="$1" project="$2" branch="$3"
  [ "$(volume_label "$volume" "wtb.managed")" = "true" ] || \
    fail "$volume is missing wtb.managed=true"
  [ "$(volume_label "$volume" "wtb.repo")" = "$REPO_LABEL" ] || \
    fail "$volume has the wrong wtb.repo label"
  [ "$(volume_label "$volume" "wtb.project")" = "$project" ] || \
    fail "$volume has the wrong wtb.project label"
  [ "$(volume_label "$volume" "wtb.branch")" = "$branch" ] || \
    fail "$volume has the wrong wtb.branch label"
}

# Resolve names with the production TypeScript implementation instead of
# duplicating the old worktree-<branch> naming assumption in the test.
plan_target() {
  local result
  result="$(node --input-type=module - "$ROOT_DIR" "$COMPOSE_FILE" "$PROJ" "$1" <<'NODE'
import path from "node:path"
import { pathToFileURL } from "node:url"
const [root, composeFile, repo, branch] = process.argv.slice(2)
const compose = await import(pathToFileURL(path.join(root, "dist/core/docker/compose.js")))
const volume = await import(pathToFileURL(path.join(root, "dist/core/docker/volume.js")))
const config = compose.readComposeFile(composeFile)
const sourceProject = compose.resolveComposeProjectNameForWorktree(
  config,
  repo,
  {},
  path.dirname(composeFile)
)
const slug = compose.uniqueProjectSlug(branch, ["main"])
const targetProject = compose.sanitizeProjectSlug(`${sourceProject}-${slug}`)
const target = volume.resolveVolumeName(config, "data", targetProject)
if (!target || target.external) throw new Error("data volume did not resolve as an internal volume")
process.stdout.write(`${targetProject}\t${target.name}`)
NODE
)"
  PLANNED_PROJECT="${result%%$'\t'*}"
  PLANNED_VOLUME="${result#*$'\t'}"
  remember_project "$PLANNED_PROJECT"
}

resolve_target() {
  local worktree="$1" result
  result="$(node --input-type=module - "$ROOT_DIR" "$worktree/$COMPOSE_REL" "$worktree" <<'NODE'
import path from "node:path"
import { pathToFileURL } from "node:url"
const [root, composeFile, worktree] = process.argv.slice(2)
const compose = await import(pathToFileURL(path.join(root, "dist/core/docker/compose.js")))
const volume = await import(pathToFileURL(path.join(root, "dist/core/docker/volume.js")))
const config = compose.readComposeFile(composeFile)
const project = compose.resolveComposeProjectNameForWorktree(
  config,
  worktree,
  {},
  path.dirname(composeFile)
)
const target = volume.resolveVolumeName(config, "data", project)
if (!target || target.external) throw new Error("data volume did not resolve as an internal volume")
process.stdout.write(`${project}\t${target.name}`)
NODE
)"
  TARGET_PROJECT="${result%%$'\t'*}"
  TARGET_VOLUME="${result#*$'\t'}"
  remember_project "$TARGET_PROJECT"
}

run_create() {
  local label="$1" branch="$2"
  shift 2
  LAST_WORKTREE="$BASE/worktree-$label"
  run_json "create-$label" create "$branch" --path "$LAST_WORKTREE" "$@"
  [ "$LAST_STATUS" -eq 0 ] || fail "create $branch exited $LAST_STATUS: $(cat "$LAST_STDERR")"
}

assert_create_ok() {
  node - "$1" <<'NODE'
const fs = require("node:fs")
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
if (value.created !== true || value.ok !== true) {
  throw new Error(`create was not successful: ${JSON.stringify(value)}`)
}
NODE
}

assert_create_volume_failure() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs")
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
const pattern = new RegExp(process.argv[3], "i")
const failures = value.volumes?.failed ?? []
if (value.created !== true || value.ok !== false || failures.length === 0) {
  throw new Error(`expected a reported volume failure: ${JSON.stringify(value)}`)
}
if (!pattern.test(JSON.stringify(failures))) {
  throw new Error(`volume failure did not match ${pattern}: ${JSON.stringify(failures)}`)
}
NODE
}

# No Docker resource with this run's project prefix may predate the test. This
# converts even an astronomically unlikely random collision into a safe abort.
if docker volume ls --format '{{.Name}}' | grep -E "^${SOURCE_PROJECT}([_-]|$)" >/dev/null; then
  fail "Docker volume prefix collision for $SOURCE_PROJECT"
fi
if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$SOURCE_PROJECT")" ]; then
  fail "Docker project collision for $SOURCE_PROJECT"
fi

mkdir -p "$PROJ/ops"
cat > "$COMPOSE_FILE" <<YAML
name: $SOURCE_PROJECT
services:
  db:
    image: busybox
    command: sleep 3600
    volumes:
      - data:/var/lib/data
volumes:
  data:
YAML
cat > "$PROJ/wtb.yaml" <<YAML
base_branch: main
docker_compose_file: ./$COMPOSE_REL
env:
  file: []
  adjust: {}
volumes:
  seed_command: >-
    docker compose -f $COMPOSE_REL run --rm db sh -c
    'printf "%s\\n" "SEEDED-$RUN_ID" > /var/lib/data/marker.txt'
YAML
git -C "$PROJ" init -q -b main
git -C "$PROJ" config user.email integ@test.local
git -C "$PROJ" config user.name "wtb integration"
git -C "$PROJ" add -A
git -C "$PROJ" commit -qm init

REPO_LABEL="$(node --input-type=module - "$ROOT_DIR" "$PROJ" <<'NODE'
import path from "node:path"
import { pathToFileURL } from "node:url"
const volume = await import(pathToFileURL(path.join(process.argv[2], "dist/core/docker/volume.js")))
process.stdout.write(volume.repoVolumeLabel(process.argv[3]))
NODE
)"

echo "🔬 wtb real-Docker integration test ($RUN_ID)"

# Start the uniquely-named source stack and discover its actual Compose-created
# volume via Docker's labels (not by assuming a global srcproj_data name).
( cd "$PROJ" && docker compose -f "$COMPOSE_REL" -p "$SOURCE_PROJECT" up -d >/dev/null )
source_matches="$(docker volume ls \
  --filter "label=com.docker.compose.project=$SOURCE_PROJECT" \
  --filter "label=com.docker.compose.volume=data" \
  --format '{{.Name}}')"
[ "$(printf '%s\n' "$source_matches" | sed '/^$/d' | wc -l | tr -d ' ')" = "1" ] || \
  fail "expected exactly one source data volume, got: $source_matches"
SOURCE_VOL="$source_matches"
remember_manual_volume "$SOURCE_VOL"
volume_set_marker "$SOURCE_VOL" "LIVE-DATA-$RUN_ID"

# 1) Running source: default create performs stop -> clone -> restart, using the
# custom Compose filename and writing exact ownership labels on the target.
BRANCH_STOP="feat/stop"
plan_target "$BRANCH_STOP"
expected_project="$PLANNED_PROJECT"
expected_volume="$PLANNED_VOLUME"
run_create stop "$BRANCH_STOP"
assert_create_ok "$LAST_JSON"
STOP_WORKTREE="$LAST_WORKTREE"
resolve_target "$STOP_WORKTREE"
[ "$TARGET_PROJECT" = "$expected_project" ] || fail "resolved project differs from plan"
[ "$TARGET_VOLUME" = "$expected_volume" ] || fail "resolved volume differs from plan"
STOP_PROJECT="$TARGET_PROJECT"
STOP_VOL="$TARGET_VOLUME"
[ "$(volume_read_marker "$STOP_VOL")" = "LIVE-DATA-$RUN_ID" ] || fail "clone lost source data"
assert_volume_ownership "$STOP_VOL" "$STOP_PROJECT" "$BRANCH_STOP"
[ -n "$(docker ps -q --filter "label=com.docker.compose.project=$SOURCE_PROJECT" --filter status=running)" ] || \
  fail "source stack was not restarted"
pass "default create stop→clone→restart works with a custom Compose filename"

# 2) --no-stop against a live source skips copying but still prepares an empty,
# exact-owned target so a later lifecycle command cannot adopt foreign data.
BRANCH_NOSTOP="feat/no-stop"
plan_target "$BRANCH_NOSTOP"
run_create no-stop "$BRANCH_NOSTOP" --no-stop
NOSTOP_WORKTREE="$LAST_WORKTREE"
node - "$LAST_JSON" <<'NODE'
const fs = require("node:fs")
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
if (!(value.volumes?.skipped?.length > 0)) throw new Error("expected a skipped live-source clone")
NODE
resolve_target "$NOSTOP_WORKTREE"
NOSTOP_VOL="$TARGET_VOLUME"
volume_is_empty "$NOSTOP_VOL" || fail "--no-stop target should be owned but empty"
assert_volume_ownership "$NOSTOP_VOL" "$TARGET_PROJECT" "$BRANCH_NOSTOP"
[ -n "$(docker ps -q --filter "label=com.docker.compose.project=$SOURCE_PROJECT" --filter status=running)" ] || \
  fail "--no-stop unexpectedly stopped the source"
pass "--no-stop leaves an empty exact-owned target and keeps the source running"

# 3) Populated unmanaged and foreign-owned targets are never overwritten, even
# with --force-volume-copy. Their bytes and ownership remain unchanged.
BRANCH_UNMANAGED="feat/unmanaged"
plan_target "$BRANCH_UNMANAGED"
UNMANAGED_VOL="$PLANNED_VOLUME"
assert_volume_absent "$UNMANAGED_VOL"
docker volume create "$UNMANAGED_VOL" >/dev/null
remember_manual_volume "$UNMANAGED_VOL"
volume_set_marker "$UNMANAGED_VOL" "UNMANAGED-PRESERVE-$RUN_ID"
run_create unmanaged "$BRANCH_UNMANAGED" --force-volume-copy
assert_create_volume_failure "$LAST_JSON" "not wtb-managed|unmanaged"
[ "$(volume_read_marker "$UNMANAGED_VOL")" = "UNMANAGED-PRESERVE-$RUN_ID" ] || \
  fail "unmanaged target data was overwritten"
[ "$(volume_label "$UNMANAGED_VOL" "wtb.managed")" != "true" ] || \
  fail "populated unmanaged target was silently adopted"
pass "populated unmanaged target is preserved even with force"

BRANCH_FOREIGN="feat/foreign"
plan_target "$BRANCH_FOREIGN"
FOREIGN_VOL="$PLANNED_VOLUME"
assert_volume_absent "$FOREIGN_VOL"
docker volume create \
  --label wtb.managed=true \
  --label "wtb.repo=foreign-$RUN_ID" \
  --label "wtb.project=foreign-$RUN_ID" \
  --label "wtb.branch=$BRANCH_FOREIGN" \
  "$FOREIGN_VOL" >/dev/null
remember_manual_volume "$FOREIGN_VOL"
volume_set_marker "$FOREIGN_VOL" "FOREIGN-PRESERVE-$RUN_ID"
run_create foreign "$BRANCH_FOREIGN" --force-volume-copy
assert_create_volume_failure "$LAST_JSON" "owned by another|ownership"
[ "$(volume_read_marker "$FOREIGN_VOL")" = "FOREIGN-PRESERVE-$RUN_ID" ] || \
  fail "foreign target data was overwritten"
[ "$(volume_label "$FOREIGN_VOL" "wtb.repo")" = "foreign-$RUN_ID" ] || \
  fail "foreign target ownership was changed"
pass "foreign-owned target is preserved even with force"

# 4) The only adoptable legacy target is empty and unused. Its immutable
# sentinel label disappearing proves recreation; exact ownership is then checked.
BRANCH_EMPTY="feat/empty-unmanaged"
plan_target "$BRANCH_EMPTY"
EMPTY_PROJECT="$PLANNED_PROJECT"
EMPTY_VOL="$PLANNED_VOLUME"
assert_volume_absent "$EMPTY_VOL"
docker volume create --label "wtb.integration.sentinel=$RUN_ID" "$EMPTY_VOL" >/dev/null
remember_manual_volume "$EMPTY_VOL"
run_create empty "$BRANCH_EMPTY"
assert_create_ok "$LAST_JSON"
[ -z "$(volume_label "$EMPTY_VOL" "wtb.integration.sentinel")" ] || \
  fail "empty unmanaged target was adopted without recreation"
assert_volume_ownership "$EMPTY_VOL" "$EMPTY_PROJECT" "$BRANCH_EMPTY"
[ "$(volume_read_marker "$EMPTY_VOL")" = "LIVE-DATA-$RUN_ID" ] || \
  fail "recreated empty target did not receive source data"
pass "empty unused unmanaged target is safely recreated and labelled"

# The remaining tests do not need a running source. Removing source containers
# keeps force-overwrite/prune assertions deterministic while preserving its volume.
( cd "$PROJ" && docker compose -f "$COMPOSE_REL" -p "$SOURCE_PROJECT" down >/dev/null )

# 5) Forced reclone is a true atomic replacement: target-only stale files are
# removed, the new source bytes arrive, and no recovery/temp/lease artifacts remain.
volume_set_marker "$SOURCE_VOL" "V2-UPDATED-$RUN_ID"
volume_add_stale_file "$STOP_VOL"
run_json reclone-stop reclone "$BRANCH_STOP" --no-stop --force-volume-copy
[ "$LAST_STATUS" -eq 0 ] || fail "reclone failed: $(cat "$LAST_STDERR")"
node - "$LAST_JSON" <<'NODE'
const fs = require("node:fs")
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
if (value.ok !== true) throw new Error(`reclone was not ok: ${JSON.stringify(value)}`)
NODE
[ "$(volume_read_marker "$STOP_VOL")" = "V2-UPDATED-$RUN_ID" ] || fail "atomic overwrite missed new data"
if volume_has_file "$STOP_VOL" stale-only.txt; then fail "atomic overwrite left stale target data"; fi
COMMON_GIT_RAW="$(git -C "$PROJ" rev-parse --git-common-dir)"
case "$COMMON_GIT_RAW" in
  /*) COMMON_GIT_DIR="$COMMON_GIT_RAW" ;;
  *) COMMON_GIT_DIR="$PROJ/$COMMON_GIT_RAW" ;;
esac
RECOVERY_DIR="$COMMON_GIT_DIR/wtb/volume-recovery"
if [ -d "$RECOVERY_DIR" ] && find "$RECOVERY_DIR" -name '*.json' -print -quit | grep -q .; then
  fail "successful overwrite left a recovery record"
fi
[ -z "$(docker volume ls -q --filter "label=wtb.repo=$REPO_LABEL" --filter label=wtb.temp=true)" ] || \
  fail "successful overwrite left a temp volume"
[ -z "$(docker ps -aq --filter "label=wtb.repo=$REPO_LABEL")" ] || \
  fail "successful overwrite left a lease/clone-lock container"
pass "forced reclone replaces bytes atomically and removes recovery artifacts"

# 6) --seed operates on the dynamically-resolved target project/volume.
BRANCH_SEED="feat/seed"
plan_target "$BRANCH_SEED"
run_create seed "$BRANCH_SEED" --seed
assert_create_ok "$LAST_JSON"
resolve_target "$LAST_WORKTREE"
SEED_VOL="$TARGET_VOLUME"
[ "$(volume_read_marker "$SEED_VOL")" = "SEEDED-$RUN_ID" ] || fail "seed command wrote the wrong volume"
assert_volume_ownership "$SEED_VOL" "$TARGET_PROJECT" "$BRANCH_SEED"
pass "seed command writes the actual isolated target volume"

# 7) Real up -> remove --remove-volumes validates immutable snapshots, project
# ownership, JSON stdout purity, and destructive volume ownership checks together.
run_json up-stop up "$BRANCH_STOP"
[ "$LAST_STATUS" -eq 0 ] || fail "wtb up failed: $(cat "$LAST_STDERR")"
[ -n "$(docker ps -q --filter "label=com.docker.compose.project=$STOP_PROJECT" --filter status=running)" ] || \
  fail "wtb up did not start the target project"
run_json remove-stop remove "$BRANCH_STOP" --remove-volumes
[ "$LAST_STATUS" -eq 0 ] || fail "wtb remove failed: $(cat "$LAST_STDERR")"
node - "$LAST_JSON" <<'NODE'
const fs = require("node:fs")
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
if (value.removed !== true || value.ok !== true || value.composeDown?.volumesRemoved !== true) {
  throw new Error(`remove contract failed: ${JSON.stringify(value)}`)
}
NODE
assert_volume_absent "$STOP_VOL"
pass "up/remove JSON lifecycle removes only the owned target stack and volume"

# 8) Create a real orphan plus a durable recovery temp. prune --yes must delete
# only the orphan and keep both a custom-compose live volume and recovery data.
BRANCH_ORPHAN="feat/orphan"
plan_target "$BRANCH_ORPHAN"
run_create orphan "$BRANCH_ORPHAN" --no-stop
assert_create_ok "$LAST_JSON"
ORPHAN_WORKTREE="$LAST_WORKTREE"
resolve_target "$ORPHAN_WORKTREE"
ORPHAN_VOL="$TARGET_VOLUME"
git -C "$PROJ" worktree remove --force "$ORPHAN_WORKTREE"

RECOVERY_PROJECT="$SOURCE_PROJECT-recovery"
RECOVERY_BRANCH="recovery/$RUN_ID"
RECOVERY_TEMP="$RECOVERY_PROJECT-data__wtbtmp_${RUN_ID//-/_}"
RECOVERY_TARGET="$RECOVERY_PROJECT-data"
RECOVERY_ID="integration_${RUN_ID//-/_}"
assert_volume_absent "$RECOVERY_TEMP"
docker volume create \
  --label wtb.managed=true \
  --label "wtb.repo=$REPO_LABEL" \
  --label "wtb.project=$RECOVERY_PROJECT" \
  --label "wtb.branch=$RECOVERY_BRANCH" \
  --label wtb.temp=true \
  "$RECOVERY_TEMP" >/dev/null
remember_manual_volume "$RECOVERY_TEMP"
volume_set_marker "$RECOVERY_TEMP" "RECOVERY-DATA-$RUN_ID"
RECOVERY_RECORD="$(node --input-type=module - \
  "$ROOT_DIR" "$RECOVERY_DIR" "$RECOVERY_ID" "$SOURCE_VOL" "$RECOVERY_TARGET" \
  "$RECOVERY_TEMP" "$REPO_LABEL" "$RECOVERY_PROJECT" "$RECOVERY_BRANCH" <<'NODE'
import path from "node:path"
import { pathToFileURL } from "node:url"
const [root, directory, id, sourceVolume, targetVolume, tempVolume, repo, project, branch] = process.argv.slice(2)
const volume = await import(pathToFileURL(path.join(root, "dist/core/docker/volume.js")))
const stored = volume.writeVolumeRecoveryRecord(directory, {
  version: 1,
  kind: "atomic-overwrite",
  id,
  createdAt: new Date().toISOString(),
  sourceVolume,
  targetVolume,
  tempVolume,
  sourceBytes: 1,
  stagedBytes: 1,
  ownership: { repo, project, branch },
})
process.stdout.write(stored.path)
NODE
)"

run_json prune-owned prune --yes
[ "$LAST_STATUS" -eq 0 ] || fail "prune --yes failed: $(cat "$LAST_STDERR")"
node - "$LAST_JSON" "$ORPHAN_VOL" "$RECOVERY_TEMP" "$NOSTOP_VOL" <<'NODE'
const fs = require("node:fs")
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
const [orphan, recovery, live] = process.argv.slice(3)
if (!value.removed.includes(orphan)) throw new Error("orphan was not removed")
if (!value.protected.includes(recovery)) throw new Error("recovery temp was not protected")
if (value.candidates.some((entry) => entry.name === live)) throw new Error("live custom-compose volume was a candidate")
NODE
assert_volume_absent "$ORPHAN_VOL"
assert_volume_exists "$NOSTOP_VOL"
assert_volume_exists "$RECOVERY_TEMP"
[ "$(volume_read_marker "$RECOVERY_TEMP")" = "RECOVERY-DATA-$RUN_ID" ] || fail "prune changed recovery data"
[ -f "$RECOVERY_RECORD" ] || fail "prune removed the protected recovery record"
pass "prune --yes removes an orphan but protects live and recovery volumes"

run_json prune-discard prune --yes --discard-recovery
[ "$LAST_STATUS" -eq 0 ] || fail "prune --discard-recovery failed: $(cat "$LAST_STDERR")"
node - "$LAST_JSON" "$RECOVERY_TEMP" <<'NODE'
const fs = require("node:fs")
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
if (!value.removed.includes(process.argv[3])) throw new Error("recovery temp was not discarded")
NODE
assert_volume_absent "$RECOVERY_TEMP"
[ ! -e "$RECOVERY_RECORD" ] || fail "discard left the recovery record behind"
pass "recovery data is discarded only with --yes --discard-recovery"

# status is the final smoke check and another stdout-purity assertion.
run_json status status --all
[ "$LAST_STATUS" -eq 0 ] || fail "status --json failed: $(cat "$LAST_STDERR")"
node - "$LAST_JSON" <<'NODE'
const fs = require("node:fs")
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
if (value.docker?.available !== true || !Array.isArray(value.worktrees)) {
  throw new Error(`unexpected status payload: ${JSON.stringify(value)}`)
}
NODE
pass "status --json stays machine-readable against a live Docker daemon"

echo "🎉 All real-Docker integration checks passed."
