#!/usr/bin/env bash
set -euo pipefail

CANONICAL="@mikaelweiss/penguin"
ALIASES=("falcra")

cd "$(dirname "$0")/.."

trap 'npm pkg set name="$CANONICAL"' EXIT

npm run build

for name in "$CANONICAL" "${ALIASES[@]}"; do
  npm pkg set name="$name"
  npm publish --access public --ignore-scripts
done
