#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

bun unlink || true

rm -rf ~/.penguin

bun install

bun link
