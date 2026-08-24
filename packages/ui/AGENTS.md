# @workspace/ui

Presentational only. Nothing here knows about workflows, runs, or Tauri.
A component that needs `invoke()` or engine types belongs in
`apps/desktop/src/components` instead. Eslint enforces this.

- `src/components/*.tsx` are shadcn primitives. The CLI writes them. Leave them
  alone and change appearance through variants and the tokens in
  `src/styles/globals.css`.
- `src/lib/utils.ts` holds `cn()` and nothing else.
- `package.json` exports are wildcards, so a new file needs no manifest edit.
- Run `bunx --bun shadcn@latest diff` before upgrading a primitive.
- The `@source` lines in `globals.css` are what make Tailwind scan the desktop
  app. Adding a second React app means adding a line.
