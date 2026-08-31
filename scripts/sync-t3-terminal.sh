#!/usr/bin/env bash
# Syncs the vendored t3code terminal emulator into packages/terminal/src.
# Vendored files are never edited by hand. To upgrade: bump SHA, rerun,
# review the git diff. T3CODE_DIR skips the clone when it holds a checkout.
set -euo pipefail

SHA=e67074f80933a27bd3cdc4e24f486358407690fb
REPO=https://github.com/pingdotgg/t3code.git

repo_root=$(cd "$(dirname "$0")/.." && pwd)
dest="$repo_root/packages/terminal"

src=${T3CODE_DIR:-}
cleanup() { :; }
if [ -z "$src" ]; then
  src=$(mktemp -d)
  cleanup() { rm -rf "$src"; }
  trap cleanup EXIT
  git -C "$src" init -q
  git -C "$src" remote add origin "$REPO"
  git -C "$src" fetch -q --depth 1 origin "$SHA"
  git -C "$src" checkout -q FETCH_HEAD
fi

actual=$(git -C "$src" rev-parse HEAD)
if [ "$actual" != "$SHA" ]; then
  echo "checkout is at $actual, expected $SHA" >&2
  exit 1
fi

files=(
  "apps/web/src/terminal/ghostty/core.ts:src/terminal/ghostty/core.ts"
  "apps/web/src/terminal/ghostty/surface.ts:src/terminal/ghostty/surface.ts"
  "apps/web/src/terminal/ghostty/renderer.ts:src/terminal/ghostty/renderer.ts"
  "apps/web/src/terminal/ghostty/keyCodes.ts:src/terminal/ghostty/keyCodes.ts"
  "apps/web/src/terminal/ghostty/runtime.ts:src/terminal/ghostty/runtime.ts"
  "apps/web/src/terminal/ghostty/vendor/ghostty-vt.wasm:src/terminal/ghostty/vendor/ghostty-vt.wasm"
  "apps/web/src/terminal/ghostty/vendor/ghostty-write-pty.wasm:src/terminal/ghostty/vendor/ghostty-write-pty.wasm"
  "apps/web/src/terminal/ghostty/fonts/SymbolsNerdFontMono-Regular.woff2:src/terminal/ghostty/fonts/SymbolsNerdFontMono-Regular.woff2"
  "apps/web/src/terminal/ghostty/fonts/LICENSE:src/terminal/ghostty/fonts/LICENSE"
  "apps/web/src/terminal-links.ts:src/terminal-links.ts"
  "packages/client-runtime/src/state/terminalSession.ts:src/state/terminalSession.ts"
  "LICENSE:LICENSE.t3code"
)

for entry in "${files[@]}"; do
  from="$src/${entry%%:*}"
  to="$dest/${entry#*:}"
  [ -f "$from" ] || { echo "missing upstream file: ${entry%%:*}" >&2; exit 1; }
  mkdir -p "$(dirname "$to")"
  cp "$from" "$to"
done

patches=()
while IFS= read -r patch; do patches+=("$patch"); done < <(
  find "$dest/patches" -maxdepth 1 -name '*.patch' 2>/dev/null | sort
)

for patch in ${patches[@]+"${patches[@]}"}; do
  name=$(basename "$patch")
  # git apply reports "Skipped patch" and still exits 0 when a path falls
  # outside its cwd, so a reverse check is what actually proves it landed.
  if ! git -C "$repo_root" apply --directory=packages/terminal -p1 "$patch" ||
    ! git -C "$repo_root" apply --directory=packages/terminal -p1 --reverse --check "$patch"; then
    echo "patch no longer applies: patches/$name" >&2
    echo "rebase it against t3code@${SHA:0:12} or drop it" >&2
    exit 1
  fi
done

{
  echo "https://github.com/pingdotgg/t3code"
  echo "$SHA"
  for entry in "${files[@]}"; do echo "${entry%%:*} -> ${entry#*:}"; done
  for patch in ${patches[@]+"${patches[@]}"}; do echo "+ patches/$(basename "$patch")"; done
} > "$dest/UPSTREAM"

echo "synced ${#files[@]} files from t3code@${SHA:0:12}, applied ${#patches[@]} patches"
