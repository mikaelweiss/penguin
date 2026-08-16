# Catalog

The npm package carries an `examples/` directory, and install copies it into `~/.wa/`. Every entry is an ordinary file after the copy: edit, delete, or replace it freely.

- `examples/agent`: the line `claude -p`, the default agent command.
- `examples/ticket.ts`: a ticket to merged PR pipeline: triage, plan, plan gate, implement, review loop, PR, then a gate loop that runs address-feedback until the user answers done.
- `examples/task.ts`: one small change in the invoking repository: implement, review loop, then a gate that commits the work or leaves it.
- `examples/fix.ts`: a bug fix: reproduce, gate when the bug does not reproduce, then a fix loop the repository checks close, a PR, and the address-feedback gate loop.
- `examples/review.ts`: a review of an open pull request: fetch the diff, review it into a findings file, then a gate that posts the file as a PR comment.
- `examples/skills/`: the step skills, one directory each, in the Agent Skills format (`20-architecture.md`, skills): `wa-triage`, `wa-plan`, `wa-implement`, `wa-review`, `wa-review-diff`, `wa-reproduce`, `wa-verify`, `wa-address-feedback`. The `wa-` prefix keeps them clear of the skills `wa sync-skills` links in.
- `examples/tsconfig.json`: maps `wa` and `zod` to the installed package for editor types.

Personal workflow ideas live in `WORKFLOWS.md`, not here.
