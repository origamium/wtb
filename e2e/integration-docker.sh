#!/usr/bin/env bash
#
# Real-Docker integration test for wtb's volume-clone / data-autonomy feature.
#
# The vitest suites (unit + e2e) deliberately avoid the Docker daemon for speed
# and CI reliability — volume operations there are boundary-mocked. This script
# is the counterpart: it exercises the *real* clone path end-to-end against a
# live daemon, proving the feature's core promise — that a new worktree starts
# with a full copy of the source volume's data.
#
# It is intentionally NOT part of `npm test`. Run it manually on a box with
# Docker:  `npm run test:integration`  (or `bash e2e/integration-docker.sh`).
#
# Covers: clone carryover, --force-volume-copy atomic overwrite, --seed, and
# `status --json` — all against real volumes, with full cleanup on exit.
set -euo pipefail

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "⏭  Docker is not available — skipping integration test (this is fine in CI)."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT_DIR/dist/cli/index.js"
if [ ! -f "$CLI" ]; then
  echo "Building CLI first (dist not found)..."
  ( cd "$ROOT_DIR" && npm run build >/dev/null )
fi

BASE="$(mktemp -d "${TMPDIR:-/tmp}/wtb-int.XXXXXX")"
PROJ="$BASE/srcproj"           # fixed basename → predictable compose project name
SRC_VOL="srcproj_data"
X_VOL="worktree-feat-x_data"
SEED_VOL="worktree-feat-seed_data"

cleanup() {
  git -C "$PROJ" worktree remove --force "$BASE/worktree-feat-x"    2>/dev/null || true
  git -C "$PROJ" worktree remove --force "$BASE/worktree-feat-seed" 2>/dev/null || true
  for v in "$SRC_VOL" "$X_VOL" "$SEED_VOL"; do docker volume rm -f "$v" >/dev/null 2>&1 || true; done
  rm -rf "$BASE"
}
trap cleanup EXIT

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; exit 1; }

mkdir -p "$PROJ"
cat > "$PROJ/docker-compose.yml" <<'YAML'
services:
  db:
    image: busybox
    command: sleep 3600
    volumes:
      - data:/var/lib/data
volumes:
  data:
YAML
cat > "$PROJ/wtb.yaml" <<'YAML'
base_branch: main
docker_compose_file: ./docker-compose.yml
volumes:
  seed_command: docker run --rm -v worktree-feat-seed_data:/d busybox sh -c 'echo SEEDED-FRESH > /d/marker.txt'
YAML
git -C "$PROJ" init -q -b main
git -C "$PROJ" config user.email integ@test.local
git -C "$PROJ" config user.name  "wtb integration"
git -C "$PROJ" add -A && git -C "$PROJ" commit -qm init

vol_read() { docker run --rm -v "$1:/d" busybox cat /d/marker.txt 2>/dev/null || echo "<missing>"; }

echo "🔬 wtb real-Docker integration test"

# 1) clone carries data over
docker volume create "$SRC_VOL" >/dev/null
docker run --rm -v "$SRC_VOL:/d" busybox sh -c 'echo V1 > /d/marker.txt'
( cd "$PROJ" && node "$CLI" create feat/x --no-stop >/dev/null 2>&1 )
[ "$(vol_read "$X_VOL")" = "V1" ] && pass "create clones source data into the new worktree volume" \
  || fail "clone did not carry data over (got '$(vol_read "$X_VOL")')"

# 2) reclone --force-volume-copy atomically overwrites with updated source
docker run --rm -v "$SRC_VOL:/d" busybox sh -c 'echo V2-UPDATED > /d/marker.txt'
( cd "$PROJ" && node "$CLI" reclone feat/x --no-stop --force-volume-copy >/dev/null 2>&1 )
[ "$(vol_read "$X_VOL")" = "V2-UPDATED" ] && pass "reclone --force-volume-copy atomically overwrites the target" \
  || fail "atomic overwrite failed (got '$(vol_read "$X_VOL")')"

# 3) --seed runs the seed command instead of cloning
( cd "$PROJ" && node "$CLI" create feat/seed --seed --no-stop >/dev/null 2>&1 )
[ "$(vol_read "$SEED_VOL")" = "SEEDED-FRESH" ] && pass "--seed runs seed_command and skips cloning" \
  || fail "--seed did not seed (got '$(vol_read "$SEED_VOL")')"

# 4) status --json is valid and reports live Docker state
( cd "$PROJ" && node "$CLI" status -a --json 2>/dev/null ) > "$BASE/status.json"
node -e '
  const j = require(process.argv[1]);
  if (!j.docker || j.docker.available !== true) { console.error("docker.available !== true"); process.exit(1); }
  if (!Array.isArray(j.worktrees) || j.worktrees.length < 3) { console.error("expected >=3 worktrees"); process.exit(1); }
' "$BASE/status.json" && pass "status --json emits valid JSON with live Docker state" \
  || fail "status --json output invalid"

echo "🎉 All real-Docker integration checks passed."
