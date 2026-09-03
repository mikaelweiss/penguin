# Files panel: port opencode's side panel

## Goal

Replace penguin's Diff panel with opencode's session side panel: a Review tab,
one tab per opened file, and an "Open file" browser tab. Behavior, layout,
toolbar, keyboard, and tab rules are opencode's. Where this plan is silent,
do what opencode does.

opencode is checked out at `~/code/opencode`. Paths below are under
`packages/`.

## What to port, and from where

| Piece                                  | opencode source                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| Tab rules: preview, open, close        | `app/src/context/layout-tabs.ts`, with its `layout-tabs.test.ts`                |
| Tab strip, plus button, middle click   | `app/src/pages/session/session-side-panel.tsx`                                  |
| Review tab: sidebar, toolbar, viewer   | `app/src/pages/session/v2/review-panel-v2.tsx`, `session-ui/src/v2/components/session-review-v2.tsx`, `session-review-file-preview-v2.tsx` |
| Review file list and kinds             | `app/src/pages/session/v2/review-diff-kinds.ts`, `session-file-list-v2.tsx`     |
| Browser tab: filter, tree, empty state | `app/src/pages/session/v2/session-file-browser-tab.tsx`                         |
| File tab contents                      | `app/src/pages/session/file-tabs.tsx`, `mode="text"`                            |
| Tree: sort, badges, ignored entries    | `app/src/components/file-tree-v2.tsx`, `file-tree-v2-model.ts`, `app/src/context/file/tree-store.ts` |
| Git: list, status, stats, patches      | `opencode/src/git/index.ts`, `opencode/src/project/vcs.ts`                      |
| Directory listing and file contents    | `opencode/src/server/routes/instance/httpapi/handlers/file.ts`                  |

The Solid code is rewritten in React. The UI is shadcn primitives, per
`CLAUDE.md`. The diff viewer stays `@pierre/diffs`, which opencode also uses.
The tree is `@pierre/trees`, the same vendor's tree, since shadcn has none and
hand-rolling one is out.

## Where penguin differs, and why

- **No server.** opencode's HTTP handlers become Tauri commands in
  `apps/desktop/src-tauri/src/lib.rs`, next to today's `run_diff`. Same
  inputs and outputs as the handlers they replace. opencode's file watcher
  becomes the `notify` crate watching the run's root and emitting one
  debounced Tauri event, which the panel listens to the way opencode listens
  to its watcher event.
- **Base picks itself.** opencode defaults to HEAD and offers the branch
  base only when the branch differs from the default. Penguin runs move
  between worktrees, so the base follows the run: a worktree diffs from the
  merge-base with origin's default branch, anything else from HEAD, as
  `run_diff` does today. The picker still lets you override.
- **The root is the repository**, resolved by the existing `project_root`
  command, so a run that cds into a subfolder keeps the same review.

## Also in this change: panel state survives a quit

opencode persists open tabs, the active tab, sidebar width, and expand mode.
Penguin persists the same, and extends it to what `use-panels.ts` holds in
memory today: which panels each run has open, which one is full screen, and
their sizes, for the terminal, web view, files, and info alike. It goes
through the same door the web tabs already use: one JSON file beside
`browser.json`, keyed by run id, read once at start and written on change,
with a `read` and `write` command shaped like `read_browser` and
`write_browser`. Per-run state is keyed by run id. Global state, like expand
mode and sidebar width, sits under one key.

## Delete

- `apps/desktop/src/components/diff-panel.tsx`
- `apps/desktop/src/hooks/use-diff-view.ts`
- The settle-on-`wrote` re-read in `use-run-diff.ts`. The watcher is the
  refresh signal now, and there is no refresh button, as in opencode.
- The "diff" panel name in `use-panels.ts` and `App.tsx` becomes "files".
- The Diff bullets in `docs/ui.html` describe the Files panel instead.

## Out of scope

- "Last turn changes". Workflows have no turns to diff between.
- Line comments, annotations, drag from the tree, the tree context menu, tab
  drag reorder, and the Context tab. Penguin's Info panel covers context.

## Done when

1. `bun run check` and `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` pass.
2. The ported tab rules pass opencode's `layout-tabs.test.ts` cases under `bun test`.
3. Side by side with opencode on the same repository, the panel does the same
   thing for: selecting and filtering changed files, unified and split, show
   all lines and hide unchanged, previous and next file, the plus button,
   single click preview, double click pin, close, middle click close, the
   browser filter with Escape and Enter, ignored entries, and expanding an
   ignored folder.
4. Editing a file in another program updates the Review tab and the open
   file tab without any click in penguin. A commit updates the Review tab.
5. A run in a worktree diffs from the branch base by default. A run in a
   plain checkout diffs from HEAD. A run outside git shows opencode's not-git
   state and still browses files.
6. Quit and relaunch: every run comes back with the same panels open, the
   same one full screen, the same sizes, the same file tabs and active tab,
   and the same sidebar width and expand mode.
7. The Info panel's stat matches the Review tab's.
