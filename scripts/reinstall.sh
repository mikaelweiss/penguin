#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

(cd apps/cli && bun unlink) || true

# Only what penguin regenerates. Workflows, helpers, adapters, and skills are the user's.
rm -rf ~/.penguin/starter
rm -f ~/.penguin/penguin-env.d.ts

bun install

(cd apps/cli && bun link)
