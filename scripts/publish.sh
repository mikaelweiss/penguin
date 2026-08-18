#!/usr/bin/env bash
set -euo pipefail

CANONICAL="@mikaelweiss/penguin"
ALIASES=("falcra")

cd "$(dirname "$0")/.."

trap 'bun pm pkg set name="$CANONICAL"' EXIT

for name in "$CANONICAL" "${ALIASES[@]}"; do
  bun pm pkg set name="$name"
  bun publish --access public --ignore-scripts
done
