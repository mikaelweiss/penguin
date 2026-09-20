# Penguin v1: the core issue

Read after looking through `packages/engine`, the example workflows and
adapters, the skills, and the desktop app. This is what I think is actually
wrong, in order of how much it matters. The first section is the root. The
rest are consequences of it, plus things I noticed that were not in the
original blurb.

## The root: the unit is a run, and a run is a person's function call

Everything in v1 is built around one shape: a person picks a workflow, fills
in params, and a process starts in a folder on their laptop. The workflow is
an `async run(ctx)` function. It lives as long as that function lives. State
is whatever local variables that function holds. Reacting to the world means
polling inside the function. Waiting means a promise that has not resolved.

That one decision explains nearly every pain point:

- **Nothing runs on its own** because nothing exists until a person calls
  `start_run`. There is no scheduler, no event ingestion, no place for a
  process to sit between events. `pr-queue.ts` is the tell: the only way to
  "watch" is an infinite `for (;;)` loop polling `gh` every few seconds
  inside a run that a person had to start and that dies with the laptop.
- **State is held badly** because it is control flow. `review-pr.ts` is 533
  lines, and most of it is a state machine written as booleans (`inDraft`,
  `paused`, `owed`, `head`, `dir`, `reviewer`) inside a `for (;;)` with a
  `Promise.race` between the agent's turn and the next PR change. A PR has
  maybe eight states and six events. Written as data, that is a table. Written
  as an imperative function that must survive pause, resume, and force pushes,
  it is a week of tweaking. The replay journal in `trace.ts` exists only to
  make a long-lived function survive process death. That is a lot of
  machinery to compensate for the state living in the wrong place.
- **Workflows are hard to read** because they mix three altitudes in one
  file: business policy ("re-review every push until merge"), agent
  choreography (open session, narrate output, parse result), and systems
  plumbing (worktree lifecycle, teardown in `finally`, freshness probes,
  `attempt` to turn the gate off, `isWithdrawn` after an ask). The
  `write-workflow` skill's file rules are the proof. Those rules are about
  systems correctness, not about the process. Any author, human or AI, has
  to get all three right at once.
- **`make-workflow.ts` did not solve "explain it and it works"** for the same
  reason. It generates TypeScript against an API that demands care at every
  call. An AI writing to that target makes the same mistakes a person does,
  and the review loop just moves the tweaking into a different chair.

So the core issue is not that v1 is about software. It is that v1's engine is
a durable function runner, and a business process is not a function. It is a
set of states, the events that move between them, and the work owed at each
transition. Some of that work is deterministic and some needs judgment.

## The second issue: the person is a blocking modal

`view.ask` is a promise that resolves when a person types. There is no inbox,
no priority, no default answer, no deadline, and no way to say "do what you
think and tell me". Every workflow gets to ask, every ask blocks a run, and
the engine's own fault gate asks too.

This is fine while a person starts every run and watches it. It is exactly
the "needy" problem once runs start themselves. The needy feeling is not
caused by too many agents. It is caused by questions that arrive one at a
time, at the run's convenience rather than the person's, with no default and
no batching. Two in-flight tasks feel like a lot because each one can
interrupt, and switching context to answer costs more than the answer.

The fix is structural, not "ask less": a single inbox for the person, every
item carrying a default and a deadline, and a digest cadence the person
chooses. That does not exist anywhere in v1 and cannot be added to
`view.ask` without changing what an ask is.

## Third: no principals, no memory, no budget

Every run acts as the user. `gh` is `@me`, git commits as the person, the
agent CLI uses their login. There is no notion of a named agent with its
own identity, its own scoped credentials, its own memory, or its own spend
limit.

- **Memory.** `~/.penguin/instructions.md` and `host.state` are the whole
  cross-run memory. An "employee" that researches the market every week has
  nowhere to keep what it learned last week. The gh adapter's `remember()`
  for watched PRs is the pattern, done ad hoc, once.
- **Budget.** `spend.ts` and `cost.ts` count. Nothing caps. An autonomous
  loop with no budget is a credit card left on the table.
- **Authority.** Nothing says what an agent may do without asking. Autonomy
  needs a ladder per action class (propose, do and report, do quietly), and
  that ladder has to be data the engine enforces, not prose in a skill.
  Today the `review-pr` skill says "never write to GitHub" in markdown and
  hopes.

## Fourth: the runtime is the laptop

Adapters call `gh`, `git`, `claude`, `bun` on the host. Runs are detached
processes on the user's machine. The desktop is the launcher. Catalog
resolution scans git worktrees. `projectRoot` and `cwd` are everywhere.

For autonomy this is the wrong host. A weekly QA run needs a browser and a
build that is not on the laptop that is closed at 11pm. "Agents need their
own computer" is really "the runtime is a service, and the desktop is one
client of it". That flips the architecture: today the engine is a library
the desktop spawns, and the CLI is a thin example runner.

## Fifth: everything is git-shaped

Even the parts that should be neutral know about repositories. The catalog
loader walks worktrees. Runs are grouped by `root`. The engine's `where()`
moves a run into a branch's checkout. The desktop's biggest components are a
diff viewer, a file tree, and a terminal.

A marketing research process has no repo. A business analysis process has no
diff to review. None of this is wrong for v1's purpose, but very little of it
carries over to "any business process", and the desktop's largest investment
(the files panel port from opencode, review tab, terminal host) is investment
in the wrong client.

## Sixth: the automation and AI boundary is per-workflow, not systemic

v1 actually does the deterministic-vs-judgment split better than most tools.
Adapters fetch tickets and diffs, workflows run gates, and the agent only
gets the judgment turn. The README says so, and the code does it.

But the rule lives in each author's head. Nothing in the engine stops a
workflow from asking an agent to do a fetch, or from hardcoding a judgment
as a regex. The boundary is convention. For "explain it and it works", the
boundary has to be in the vocabulary: a deterministic step cannot call a
model, and a judgment step cannot touch the world except through declared
tools with declared authority.

## Things not in the original blurb

- **Reversibility.** An autonomous agent posting comments, emailing, or
  changing a listing needs draft-first and undo as defaults. v1 has no
  staging concept. `review-pr` posts straight to GitHub after one ask.
- **Idempotency and dedup.** An event-driven system sees the same event
  twice. v1's only dedup is a `Set<number>` in `pr-queue.ts`. This has to be
  in the engine: every event has an id, every transition is idempotent.
- **Evaluation.** `exam.ts` and `jev-exam.ts` show the need was felt: how do
  you know a process is any good? But an exam is another run. Autonomous
  work needs every instance to leave an auditable artifact and a score the
  person can sample later, not a separate examination workflow.
- **"What happened while I was away".** The desktop shows a transcript per
  run. That is the wrong view for autonomy. The person needs a digest across
  processes: what ran, what it decided, what it spent, what it wants.
- **Concurrency limits.** Child runs are processes. There is no scheduler,
  no priority, no "at most two browser jobs at once". Autonomy without
  limits means a bad Monday morning.
- **Secrets.** `store-secret.ts` puts one secret in the OS keychain. Agents
  with their own machines need scoped tokens per role, rotated, and never
  the person's own login.
- **Adapter sprawl.** Six agent adapters (claude, codex, cursor, copilot,
  opencode, pi) at 250 to 430 lines each, all parsing a CLI's stream format.
  Plus 1400 lines for a third-party screening API. That is maintenance, not
  leverage. One agent runtime with a stable API beats six CLIs.
- **The trace file is almost an event log.** `run.jsonl` with `call`,
  `outcome`, `pending`, `replayed` is one refactor away from being the
  system of record for an event-sourced engine. That is worth keeping in
  spirit, not in shape.
- **Skills are coupled to workflows by convention.** A workflow sends
  `{ skill: "review-pr" }` and expects a zod result. The skill prose knows
  the workflow will post for it. Nothing checks this contract. Half the
  skills exist to serve exactly one workflow.
- **"Any business process" is too wide as a target.** It is the right
  direction and the wrong first scope. Without a small fixed vocabulary, the
  AI that compiles prose to a process will generate arbitrary complexity,
  and v2 will re-grow v1's problems in a new syntax.

## What v1 got right, and should survive

- Adapters as pure bridges with plain data in and out.
- "Answers are data, refusals are faults", and the fault gate with a
  bounded fixer before a person.
- Typed agent results through zod. The agent returns a shape, not prose.
- Preflight checks before a run starts.
- Skills as a catalog of reusable instructions separate from runtime data.
- The discipline in the docs and READMEs. The model is explained in one
  page and the code matches it.
- The UI package and the shadcn rules. The client can be rebuilt on it.
