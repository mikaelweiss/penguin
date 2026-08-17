#!/usr/bin/env bash
set -euo pipefail

NAMES=("@mikaelweiss/penguin" "falcra")

cd "$(dirname "$0")/.."

original=$(node -p "require('./package.json').name")
trap 'npm pkg set name="$original"' EXIT

npm run build

for name in "${NAMES[@]}"; do
  npm pkg set name="$name"
  npm publish --access public --ignore-scripts
done
