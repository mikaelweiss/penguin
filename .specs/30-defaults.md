# Catalog

The npm package carries an `examples/` directory, and install copies it into `~/.wa/`. Every entry is an ordinary file after the copy: edit, delete, or replace it freely.

- `examples/adapters/claude.ts`: the `agent` role on the claude CLI: sessions over `--session-id` and `--resume`, stream-json into typed agent events, results over `--json-schema`.
- `examples/adapters/git.ts`: the `vcs` role on git: staging, commits, and worktrees.
- `examples/adapters/gh.ts`: the `github` role on the gh CLI: create, diff, and comment on pull requests.
- `examples/adapters/terminal.ts`: the `view` role: events as terminal lines, and a live footer on a TTY.
- `examples/ticket.ts`: a ticket to merged PR pipeline: triage, plan, plan gate, a worktree, a persistent implementer with fresh reviewers per round, PR, then a gate loop that runs address-feedback until the user answers done.
- `examples/task.ts`: one small change in the invoking repository: a persistent implementer, a review round activity with accumulated findings, then a gate that commits the work or leaves it.
- `examples/fix.ts`: a bug fix: reproduce, gate when the bug does not reproduce, then a fix loop the repository checks close, a PR, and the address-feedback gate loop.
- `examples/review.ts`: a review of an open pull request: fetch the diff, review it into a findings file, then a gate that posts the file as a PR comment.
- `examples/skills/`: the step skills, one directory each, in the Agent Skills format (`20-architecture.md`, skills): `wa-triage`, `wa-plan`, `wa-implement`, `wa-review`, `wa-review-diff`, `wa-reproduce`, `wa-verify`, `wa-address-feedback`. The `wa-` prefix keeps them clear of the skills `wa sync-skills` links in.
- `examples/tsconfig.json`: maps `wa` and `zod` to the installed package for editor types, and includes the adapters and the generated `wa-env.d.ts`.
- `examples/wa-env.d.ts`: the generated ctx types for the shipped adapters. wa rewrites it after install (`20-architecture.md`, storage).

Personal workflow ideas live in `WORKFLOWS.md`, not here.
