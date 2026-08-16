# Defaults

The engine ships empty. No adapter, workflow, or skill is part of the core, and every entry below is removable (`20-architecture.md`, invariant 16). This file is the catalog of what a fresh install contains.

## Pre-built adapters

Compiled into the released binary. Each one registers itself, and the engine core imports none of them.

- Agents: claude, codex, cursor, pi.
- Event sources: github, linear, jira, slack, webhook, schedule, cli.
- Channels: cli, github, slack.
- VCS: git, jj.

## Default workflows

Install writes these into `~/.wa/workflows/` and their skills into `~/.wa/skills/`, and never overwrites an existing file. After that they are ordinary personal definitions: edit, delete, or replace them freely.

- `new-workflow`: interview the user, draft a workflow, loop on `wa lint` and `wa sim` until both pass.
- `new-adapter`: scaffold an adapter: the Go interface implementation, the typed TS module, tests.
- `new-skill`: draft a skill file from a description or an example transcript.
- `mine-transcripts`: read agent session logs (claude, codex, cursor, pi), find repeated procedures, draft workflows and skills from them.
- `retro`: after a run, diff what the workflow said against what happened, and propose a workflow edit.
- `ticket`: a generic ticket to merged PR pipeline: triage, plan, plan gate, implement, review loop, PR, feedback until merge. Step skills: triage, plan, implement, review, address-feedback.

Personal workflow ideas live in `WORKFLOWS.md`, not here.
