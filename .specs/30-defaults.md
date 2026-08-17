# Catalog

The npm package carries an `examples/` directory, and install copies it into `~/.penguin/`. Every entry is an ordinary file after the copy: edit, delete, or replace it freely.

- `examples/adapters/claude.ts`: the `agent` role on the claude CLI: sessions over `--session-id` and `--resume`, stream-json into typed agent events (text, thinking, and each tool call with what it acts on), results over `--json-schema`.
- `examples/adapters/git.ts`: the `vcs` role on git: staging, commits, and worktrees.
- `examples/adapters/gh.ts`: the `github` role on the gh CLI: read an issue and its comments, and create, diff, and comment on pull requests.
- `examples/adapters/jira.ts`: the `jira` role on the Jira Cloud REST API: read an issue and its comments, and search, create, comment on, and transition issues, under a token penguin asks for once (`20-architecture.md`, credentials).
- `examples/adapters/terminal.ts`: the `view` role: events as terminal lines, and a live footer on a TTY. A tool call is one line, the name and what it acts on, cut to the terminal width. Thinking is dim and indented.
- `examples/ticket.ts`: a ticket to merged PR pipeline: it calls triage, then plan and implement per task, then pr, and holds the work in a worktree.
- `examples/fix.ts`: a bug fix: reproduce, gate when the bug does not reproduce, then a fix loop that calls verify until the repository checks pass, then pr.
- `examples/triage.ts`: the triage loop: is the ticket ready to work on, the deciding fact, and the tasks that build it. Questions gate to the user first, and a split into more than one task holds at an approve-or-revise gate.
- `examples/plan.ts`: the plan loop: questions gate to the user first, then the plan holds at an approve-or-revise gate, and a revision answer feeds back to the planner. A ticket that reads as a Jira key or a GitHub issue number is fetched first, and anything else is the text itself.
- `examples/implement.ts`: a persistent implementer with a fresh review call per round, accumulated findings, and a `rounds` bound.
- `examples/review.ts`: one review turn of a working tree against its acceptance checks and the findings so far.
- `examples/verify.ts`: one verify turn: the checks of the repository, and what fails.
- `examples/pr.ts`: the pull request, then a gate loop that runs address-feedback until the user answers done.
- `examples/review-pr.ts`: a review of an open pull request: fetch the diff, review it into a findings file, then a gate that posts the file as a PR comment.
- `examples/make-workflow.ts`: an idea to a new workflow: a design held at an approval gate, then a write-and-review loop with a `rounds` bound, into the home or the project.
- `examples/skills/`: the step skills, one directory each, in the Agent Skills format (`20-architecture.md`, skills): `penguin-triage`, `penguin-plan`, `penguin-implement`, `penguin-review`, `penguin-review-diff`, `penguin-reproduce`, `penguin-verify`, `penguin-address-feedback`, `penguin-design-workflow`, `penguin-write-workflow`, `penguin-review-workflow`. The `penguin-` prefix keeps them clear of the skills `pn sync-skills` links in.
- `examples/tsconfig.json`: maps `penguin` and `zod` to the installed package for editor types, and includes the adapters and the generated `penguin-env.d.ts`.
- `examples/penguin-env.d.ts`: the generated ctx types for the shipped adapters. penguin rewrites it after install (`20-architecture.md`, storage).

The big workflows call the small ones (`10-workflow-model.md`, composition), and every workflow also runs alone.

Personal workflow ideas live in `WORKFLOWS.md`, not here.
