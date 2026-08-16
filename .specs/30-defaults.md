# Catalog

The core ships empty (`20-architecture.md`, invariant 7). The npm package carries an `examples/` directory, and copying a file out of it is the whole install. Every entry is an ordinary file after the copy: edit, delete, or replace it freely.

- `examples/agent`: the line `claude -p`. Copy it to `~/.wa/agent` to set the default agent.
- `examples/ticket.ts`: a generic ticket to merged PR pipeline: triage, plan, plan gate, implement, review loop, PR, then a gate loop that runs address-feedback until the user answers done.
- `examples/skills/`: the step skills for `ticket.ts`: `triage.md`, `plan.md`, `implement.md`, `review.md`, `address-feedback.md`.
- `examples/tsconfig.json`: maps `wa` and `zod` to the installed package for editor types. Copy it next to your workflow files.

Personal workflow ideas live in `WORKFLOWS.md`, not here.
