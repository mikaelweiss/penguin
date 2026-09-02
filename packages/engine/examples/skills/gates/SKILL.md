---
name: gates
description: Finds the quality gate commands a repository already defines and writes them as the lines of a gates file. Use once per project, before any change is built.
---

# Find the gates

Say which commands decide whether this repository is green. Change nothing: no edit, no commit, no new file. Do not run a gate to see what it does.

1. Read what the repository says about itself, in one batch: `package.json` scripts, `AGENTS.md`, `CLAUDE.md`, `README.md`, `Makefile`, and every CI workflow under `.github/workflows`. A repository on another stack names them elsewhere: an Xcode scheme and its test plan, `build.gradle`, `Cargo.toml`, a Go module's `Makefile` targets.
2. Take the commands those files name. CI is the strongest source: what a merge has to pass is what a review has to pass. Never guess a command, and never try several spellings of one.
3. Keep the set small. The type check, the linter, and the tests are the whole of it. Leave out what needs a network, a device, a database, or a person.
4. Scope a gate when the repository is a monorepo and the command covers one workspace. An unscoped gate runs on every change, so a gate that only makes sense for one folder gets that folder.
5. Put one gate per line in `lines`, in the syntax below.

## The syntax

A line is a command, run for every change:

    bun run check

A line opening with a path in brackets is a command that runs only when the change touches something under that path:

    [apps/desktop] nx run penguin-desktop:typecheck
    [packages/engine] bun test packages/engine

The path is matched by whole segments, so `[apps/desktop]` covers `apps/desktop/src/x.ts` and never `apps/desktop-old/x.ts`.

Each command runs through a shell from the repository root, or from the worktree holding the change. Write it so it works from there.

## Read in batches

Every tool call sends the whole conversation to the model again, so ten small reads cost ten times what one read of the same files costs. When you know the next several files or searches you need, run them in one command. One call per question, not one per file.
