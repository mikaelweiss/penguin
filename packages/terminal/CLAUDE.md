# @workspace/terminal

The t3code terminal emulator (libghostty-vt WASM, canvas renderer), vendored
verbatim. MIT licensed; the notice is `LICENSE.t3code`.

- **Never edit anything under `src/`.** Every file there is generated: copied
  byte-for-byte from t3code, or a shim whose functions are copied verbatim,
  then rewritten by the patches below. `UPSTREAM` records the pinned commit,
  the file map, and the applied patches.
- A fix belongs upstream or in penguin's glue. When it fits neither, record it
  as a patch in `patches/`, numbered, one concern each, and regenerate it with
  `git diff --relative=packages/terminal` rather than hand-editing the file.
- To upgrade: bump `SHA` in `scripts/sync-t3-terminal.sh`, run it, review the
  git diff. The script re-copies, then reapplies every patch, and fails if one
  no longer applies. Rebase it against the new commit or drop it.
- `types/*.d.ts` are the hand-written public API the rest of the repo
  typechecks against; the `exports` map serves them to tsc while Vite loads
  the sources. A resync that changes the API means updating `types/` to match.
- `contracts-shim/` is a type-only stand-in for `@t3tools/contracts`. The
  penguin terminal host (`packages/engine/src/terminal-host.ts`) emits these
  event shapes over WebSocket.
- Eslint ignores `src/**`; the package typechecks through its own tsconfig,
  which mirrors t3code's web config, not penguin's.
