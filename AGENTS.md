# penguin

Bun workspaces plus Nx. Bun is the runtime and the package manager.
Never run npm, pnpm, or yarn.

## Workspaces

| Path              | Package                        | What it is                                            |
| ----------------- | ------------------------------ | ----------------------------------------------------- |
| `apps/desktop`    | `@mikaelweiss/penguin-desktop` | Tauri + Vite + React. Screens and Tauri IPC.          |
| `apps/docs`       | `@mikaelweiss/penguin-docs`    | Bun server for `docs/*.html`. Its own Tailwind build.  |
| `packages/engine` | `@mikaelweiss/penguin-engine`  | Workflow engine. No DOM, no React.                     |
| `packages/ui`     | `@workspace/ui`                | shadcn primitives and theme tokens. No Tauri.          |

## Commands

    bun install
    bun run check                  # root tsc, then nx typecheck, then eslint
    nx run-many -t typecheck       # apps/desktop and packages/ui
    eslint .
    bun run desktop                # tauri dev, from anywhere
    nx serve docs

Root `tsc` covers the Bun-side projects. `apps/desktop` and `packages/ui` are
excluded from it and typecheck through their own configs.

## UI

Tailwind v4, CSS-first. There is no `tailwind.config.js` and none may be created.
Everything is shadcn stock. Do not customize what the CLI generates.

**shadcn wins every disagreement.** The ui.sh `design`, `ideas`, and `ui` skills
are installed, and their rule files contradict shadcn on buttons, form controls,
icons, colors, cards, and dark mode. Where they conflict, shadcn is right.
Take from ui.sh only what shadcn has no opinion on: page layout, spacing rhythm,
responsive breakpoints, and Tailwind authoring style. In practice that means
`general.md`, `flexbox-layout.md`, `responsive-design.md`, `section-layout.md`,
and `typography.md`. Ignore `buttons.md`, `form-controls.md`, `icons.md`,
`colors.md`, `surfaces.md`, `badges.md`, `tables.md`, `navigation.md`,
`pagination.md`, `avatars.md`, and the color rules in `dark-mode.md`.

Hand-rolled UI is a failure, not a fallback. In order, always:

1. `bunx --bun shadcn@latest search <term>` and install what already exists.
2. Compose installed primitives. A settings page is Tabs + Card + Field.
3. Only if neither works, write a component, and say out loud that you did.

- Add components from the app:
  `cd apps/desktop && bunx --bun shadcn@latest add <name>`.
  Primitives land in `packages/ui/src/components`, composed blocks in
  `apps/desktop/src/components`. Leave them where the CLI puts them.
- Do not edit generated primitives. Change appearance with variants and tokens.
- `className` carries layout only, never component color or typography.
- Semantic tokens only: `bg-background`, `text-muted-foreground`, `bg-primary`.
  No raw palette colors. No manual `dark:` color overrides.
- Icons are lucide, `size-4`, colored with `text-*`.
- The theme is the `nova` preset on a neutral base, in Geist Variable.
  Change it with `bunx --bun shadcn@latest apply --preset <name>`.
  Never hand-edit the OKLCH variables in `globals.css`.
- Dialogs only. Never Sheet or Drawer. This is the one deliberate deviation
  from stock shadcn. Do not "fix" it.

Design tokens live only in `packages/ui/src/styles/globals.css`.
`apps/docs` is a separate hand-authored surface with its own stylesheet and no
shadcn. The ui.sh `design` skill applies there in full.

## Adding a workspace

A package needs `package.json` with an `nx.tags` entry and a `tsconfig.json`.
Add the new tag to `depConstraints` in `eslint.config.js` in the same commit.
An untagged project passes every boundary check.
