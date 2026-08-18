# Catalog

The npm package carries an `examples/` directory, and install copies it into `~/.penguin/`. Every entry is an ordinary file after the copy: edit, delete, or replace it freely.

- `examples/adapters/claude.ts`: the `agent` role on the claude CLI: sessions over `--session-id` and `--resume`, stream-json into typed agent events (text, thinking, and each tool call with what it acts on), results over `--json-schema`.
- `examples/adapters/codex.ts`: the `agent` role on the codex CLI: one codex thread per penguin session, started on the first turn and resumed by id after, the `--json` stream into typed agent events (text, thinking, and each tool call with what it acts on), results over `--output-schema`, and the model and the sandbox mode as `-c` overrides.
- `examples/adapters/git.ts`: the `vcs` role on git: staging, commits, worktrees, what the tree and the head hold, fetching a ref, pulling a fetched ref into a working tree, rebasing a branch onto a ref, and merging one branch into the checked-out one. A rebase call reports the files it stopped on, so the workflow drives the resolution and the continue. A worktree whose path is taken is reported, never overwritten, and a forced removal deletes a path git refuses to remove.
- `examples/adapters/gh.ts`: the `github` role on the gh CLI: read an issue or a pull request and its comments, create, diff, comment on, and approve pull requests, and watch one pull request as a subscription of typed changes.
- `examples/adapters/jira.ts`: the `jira` role on the Jira Cloud REST API: read an issue and its comments, and search, create, comment on, and transition issues, under a token penguin asks for once (`20-architecture.md`, credentials).
- `examples/ship.ts`: a ticket to open PR pipeline: it calls work, then open-pr.
- `examples/ship-local.ts`: a ticket to landed commit pipeline: it calls work, commits, then holds at a gate until the user answers done or asks for a change, and lands the branch with land.
- `examples/work.ts`: the shared middle of both pipelines: triage the ticket, hold the work in a worktree named for it, then plan and implement each task.
- `examples/triage.ts`: the triage loop: is the ticket ready to work on, the deciding fact, and the tasks that build it. Questions gate to the user first, and a split into more than one task holds at an approve-or-revise gate.
- `examples/plan.ts`: the plan loop: questions gate to the user first, then the plan holds at an approve-or-revise gate, and a revision answer feeds back to the planner. A ticket that reads as a Jira key or a GitHub issue number is fetched first, and anything else is the text itself.
- `examples/implement.ts`: a persistent implementer with a fresh review call per round, accumulated findings, and a `rounds` bound.
- `examples/review.ts`: one review turn of a working tree against its acceptance checks and the findings so far.
- `examples/commit.ts`: one commit: the message is an agent turn, and the staging and the commit are engine calls. A tree with nothing to commit reports it and writes nothing.
- `examples/land.ts`: the rebase loop: fetch the target, rebase the branch onto it, and give each conflict to an agent, up to a `resolutions` bound. A pass that conflicted repeats, up to a `passes` bound, so the branch lands on a target nothing moved under it. Then the checked-out target fast-forwards to the branch.
- `examples/open-pr.ts`: the pull request, then a gate loop that runs address-feedback until the user answers done.
- `examples/review-pr.ts`: a review of an open pull request that follows it until it closes: a worktree on the PR head, a gate to use, replace, or exit when that path is already taken, an agent review fed the PR conversation and interrupted with changes as they land, findings as blockers and non-blockers, a gate on blockers, the feedback posted as a comment, an approve when nothing blocks, and a fresh review round on every push. A draft PR waits, and previous findings feed each new round.
- `examples/make-workflow.ts`: an idea to a new workflow: a design held at an approval gate, then a write-and-review loop with a `rounds` bound, into the home or the project.
- `examples/skills/`: the step skills, one directory each, in the Agent Skills format (`20-architecture.md`, skills): `penguin-triage`, `penguin-plan`, `penguin-implement`, `penguin-review`, `penguin-commit`, `penguin-resolve-conflicts`, `penguin-review-pr`, `penguin-address-feedback`, `penguin-design-workflow`, `penguin-write-workflow`, `penguin-review-workflow`. The `penguin-` prefix keeps them clear of the skills `pn sync-skills` links in.
- `examples/defaults`: the role choices the catalog ships, one line, `agent claude`. Two agent adapters arrive together, and this line says which one a run takes (`20-architecture.md`, adapters).
- `examples/tsconfig.json`: maps `penguin` and `zod` to the installed package for editor types, and includes the adapters and the generated `penguin-env.d.ts`.
- `examples/penguin-env.d.ts`: the generated ctx types for the shipped adapters. penguin rewrites it after install (`20-architecture.md`, storage).

The big workflows call the small ones (`10-workflow-model.md`, composition), and every workflow also runs alone. The name says which is which: a step is one bare verb (`plan`, `implement`, `review`, `commit`, `land`, `triage`, `work`), and a pipeline is a compound or an outcome (`ship`, `ship-local`, `open-pr`, `review-pr`, `make-workflow`).

Personal workflow ideas live in `WORKFLOWS.md`, not here.
