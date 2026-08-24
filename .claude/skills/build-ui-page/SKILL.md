---
name: build-ui-page
description: build out a single page of UI in penguin
user-invocable: true
---

# Build UI Page

Routes a page build to the right pair of skills. Two design systems are
installed here and they disagree, so pick before writing anything.

## 1. Read the spec

`docs/ui.html` is the product UI spec. Find the screen being built and read
its section. If the screen is not in there, ask what it should contain before
writing code.

## 2. Pick the surface

**Target in `apps/docs`.** Hand-authored HTML, no components, no shadcn.
Load the `design` skill and follow it in full. Stop reading here.

**Target in `apps/desktop` or `packages/ui`.** Load both `shadcn` and `design`.
shadcn wins every conflict. See the UI section of the root `AGENTS.md` for
which `design` rule files still apply and which are overridden.

## 3. Inventory before building

List the components the page needs, then for each one:

    bunx --bun shadcn@latest search <term>

Install what exists. Compose what is close. Write a new component only when
neither works, and say so explicitly when you do.

## 4. Optional: compare directions

If the layout is genuinely open, use the `ideas` skill to put two or three
options side by side in the browser before committing to one.

## Verify

- `bun run check` passes.
- The page renders in `bun run desktop`, light and dark, with `d` toggling.
- No raw palette colors, no `tailwind.config.js`, no hand-styled primitives.
