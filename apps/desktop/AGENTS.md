# desktop

Tauri v2 + Vite + React.

- Rust lives in `src-tauri`. Vite must keep ignoring it in `server.watch.ignored`,
  and the dev server must stay on port 1420 with `strictPort`.
- `src/components` is for composed penguin UI that talks to the engine or Tauri.
  Anything reusable and presentational belongs in `@workspace/ui`.
- Import the design system by name, `@workspace/ui/components/button`.
  Relative paths into `packages/` are an eslint error.
- `bun run desktop` from the repo root runs the app. Plain `vite` opens a
  browser where every `invoke()` throws.
- `app-icon.svg` is the only editable icon source. Everything in
  `src-tauri/icons` is generated, so change the SVG and run `bun run icon`.
