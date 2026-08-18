#!/usr/bin/env bash
set -euo pipefail

CANONICAL="@mikaelweiss/penguin"
ALIASES=("falcra")

cd "$(dirname "$0")/.."

bun publish --cwd packages/engine --access public --ignore-scripts
bun publish --cwd packages/viewer --access public --ignore-scripts

trap 'bun pm pkg set name="$CANONICAL" --cwd apps/cli' EXIT

for name in "$CANONICAL" "${ALIASES[@]}"; do
  bun pm pkg set name="$name" --cwd apps/cli
  bun publish --cwd apps/cli --access public --ignore-scripts
done
