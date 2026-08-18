#!/usr/bin/env bash
set -euo pipefail

CANONICAL="@mikaelweiss/penguin"
ALIASES=("falcra")

cd "$(dirname "$0")/.."

bun publish --filter @mikaelweiss/penguin-engine --access public --ignore-scripts
bun publish --filter @mikaelweiss/penguin-viewer --access public --ignore-scripts

trap 'bun pm pkg set name="$CANONICAL" --cwd apps/cli' EXIT

for name in "$CANONICAL" "${ALIASES[@]}"; do
  bun pm pkg set name="$name" --cwd apps/cli
  bun publish --filter "$name" --access public --ignore-scripts
done
