# Defaults

The engine ships empty. No agent, workflow, or skill is part of the core, and every entry below is removable (`20-architecture.md`, invariant 7). This file is the catalog of what a fresh install contains.

## Default agent config

Install writes `~/.wa/config.toml` with one agent entry, claude, set as the default agent. An agent entry is a command template, not code: edit it, replace it, or add others freely.

## Default workflows

Install writes one workflow into `~/.wa/workflows/` and its skills into `~/.wa/skills/`, and never overwrites an existing file. After that it is an ordinary personal definition: edit, delete, or replace it freely.

- `ticket`: a generic ticket to merged PR pipeline: triage, plan, plan gate, implement, review loop, PR, then a gate loop that runs address-feedback until the user answers done. Step skills: triage, plan, implement, review, address-feedback.

Personal workflow ideas live in `WORKFLOWS.md`, not here.
