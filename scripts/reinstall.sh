#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

(cd apps/cli && bun unlink) || true

rm -rf ~/.penguin

bun install

(cd apps/cli && bun link)
