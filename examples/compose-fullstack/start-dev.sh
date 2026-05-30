#!/usr/bin/env bash
# Runs in the new worktree after creation. Brings the (port-remapped) stack up.
set -euo pipefail
echo "▶ starting compose-fullstack stack for this worktree"
docker compose up -d
