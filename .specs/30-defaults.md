# Defaults

The engine ships empty. No agent, workflow, or skill is part of the core, and every entry below is removable (`20-architecture.md`, invariant 8). This file is the catalog of what a fresh install contains.

## Default agent config

Install writes `~/.wa/config.toml` with one agent entry, claude, set as the default agent. An agent entry is a command template, not code: edit it, replace it, or add others freely.

## Default workflows

Install writes these into `~/.wa/workflows/` and their skills into `~/.wa/skills/`, and never overwrites an existing file. After that they are ordinary personal definitions: edit, delete, or replace them freely.

- `new-workflow`: interview the user, draft a workflow, and typecheck it with `tsc` against the `.wa/` tsconfig until clean.
- `ticket`: a generic ticket to merged PR pipeline: triage, plan, plan gate, implement, review loop, PR, then a gate loop that runs address-feedback until the user answers done. Step skills: triage, plan, implement, review, address-feedback.

Personal workflow ideas live in `WORKFLOWS.md`, not here.
