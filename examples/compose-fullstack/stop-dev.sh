#!/usr/bin/env bash
# Runs in the worktree before removal. Tears the stack down (volumes are kept
# unless `wtb remove --remove-volumes` is used).
set -euo pipefail
echo "▶ stopping compose-fullstack stack for this worktree"
docker compose down
