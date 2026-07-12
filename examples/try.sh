#!/usr/bin/env bash
#
# try.sh — run the locally built wtb against one of the example projects, in a
# throwaway git repo, so you can see wtb work end-to-end without touching anything
# real.
#
# Usage:
#   examples/try.sh <example> [branch] [--real] [--seed]
#
#   <example>  one of the subdirectories here (run with no args to list them)
#   branch     branch to create        (default: feature/demo)
#   --real     actually create the worktree (default: --dry-run, zero side effects)
#   --seed     pass --seed to wtb create (only meaningful with --real + a seed_command)
#
# Examples:
#   examples/try.sh minimal
#   examples/try.sh compose-minimal feature/db --real
#   examples/try.sh compose-seed feature/fresh --real --seed
#   examples/try.sh compose-identity feature/demo
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

list_examples() {
  echo "Available examples:"
  for d in "$SCRIPT_DIR"/*/; do
    [ -f "$d/wtb.yaml" ] && echo "  - $(basename "$d")"
  done
}

EXAMPLE="${1:-}"
if [ -z "$EXAMPLE" ] || [ ! -d "$SCRIPT_DIR/$EXAMPLE" ]; then
  [ -n "$EXAMPLE" ] && echo "No such example: $EXAMPLE" >&2
  list_examples
  exit 1
fi
shift

BRANCH="feature/demo"
DRY="--dry-run"
SEED=""
for a in "$@"; do
  case "$a" in
    --real) DRY="" ;;
    --seed) SEED="--seed" ;;
    --*) echo "Unknown flag: $a" >&2; exit 2 ;;
    *) BRANCH="$a" ;;
  esac
done

SRC="$SCRIPT_DIR/$EXAMPLE"
CLI="$REPO_ROOT/dist/cli/index.js"
if [ ! -f "$CLI" ]; then
  echo "▶ building wtb (dist/ missing)…"
  (cd "$REPO_ROOT" && npm run build >/dev/null)
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wtb-example-XXXXXX")"
# Explicit, per-(example,branch) worktree path so repeated runs don't collide on
# the default `../worktree-<branch>` location.
WT_PATH="$(dirname "$WORK")/wtb-wt-${EXAMPLE}-$(echo "$BRANCH" | tr '/' '-')"
rm -rf "$WT_PATH"

cleanup_hint() {
  echo ""
  echo "🧹 cleanup when done:"
  echo "   rm -rf $WORK $WT_PATH"
}
trap cleanup_hint EXIT

# Materialize the example as a standalone git repo (wtb operates on a git repo and
# adds worktrees as siblings of it).
cp -R "$SRC/." "$WORK/"
cd "$WORK"
git init -q -b main
git add -A
git -c user.email=demo@example.com -c user.name=wtb-demo commit -qm "init: $EXAMPLE example"

echo "════════════════════════════════════════════════════════════"
echo " example : $EXAMPLE"
echo " workdir : $WORK"
echo " worktree: $WT_PATH"
echo " command : wtb create $BRANCH -p <worktree> $DRY $SEED"
echo "════════════════════════════════════════════════════════════"
node "$CLI" create "$BRANCH" -p "$WT_PATH" $DRY $SEED

if [ -z "$DRY" ]; then
  echo ""
  echo "▶ wtb ls -l"
  node "$CLI" ls -l || true
  echo ""
  echo "▶ wtb ports --all --pretty"
  node "$CLI" ports --all --pretty || true
fi
