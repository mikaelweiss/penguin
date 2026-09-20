# What is actually wrong with penguin v1

Written after reading the engine, the starter catalog, the desktop app, and the docs.
Concrete references are to files in this repo so each claim can be checked.

## The one sentence

Penguin v1 is a programmable runner for software tasks that a person starts by hand, on
their own laptop, and then babysits. Every layer assumes that, and the v2 goals contradict
every one of those assumptions:

| Layer            | v1 assumes                               | v2 needs                                   |
| ---------------- | ---------------------------------------- | ------------------------------------------ |
| Unit of work     | a run, started by a person, in a folder  | a standing role that owns work over time   |
| Process language | TypeScript against typed adapters        | a description a non-programmer can give    |
| Event loop       | the person, blocking on `view.ask`       | the system, with the person as a stakeholder |
| State            | git and GitHub, re-read every time       | a memory the business accumulates          |
| Computer         | the user's laptop                        | machines the agents own                    |
| Frontend         | the Tauri app, with a demo CLI           | a CLI that is the whole API                |

None of these are bugs. They are the design, and the design was right for "I am at my desk
and I want this ticket shipped." They are wrong for "run my business while I am at work."

## Core issue 1: the workflow author does the engine's job and the agent's job

The engine is deliberately tiny. `packages/engine/src/core/README.md` lists five jobs and
says anything else is a workflow or an adapter. The consequence is that every hard thing
was pushed into workflow files, and every workflow re-solves it by hand:

- **Event loops.** `open-pr.ts` is 531 lines. The process it encodes is two sentences:
  open the PR, answer feedback until it merges. The other five hundred lines are
  `wake`/`pending`/`poke` plumbing, a `tracked()` watcher per base branch, a `closed`
  promise raced against every ask, and re-reading the PR after every block. `pr-queue.ts`
  is a `for(;;)` that polls `gh` every 30 seconds inside one process. If the process dies,
  the watch is gone.
- **Context assembly.** `commit.ts`, `open-pr.ts`, `implement.ts`, `review-pr.ts` each
  hand-build the prompt from adapter calls (`section()`, `brief()`, `checklist()`,
  `threaded()`, `changed()`). The README's principle "agents shouldn't fetch what a script
  can fetch" is a real cost optimization, but it makes the workflow the prompt compiler.
  Every change to what the agent should see is a code change.
- **Approval loops.** `for (;;) { ask; if approve break; input = revision }` appears in
  `triage.ts`, `plan.ts`, `make-workflow.ts`, `work.ts`, `open-pr.ts`. Same shape, written
  five times.
- **Token economics.** `agent.open({ model: "small", tools: [], settings: [], effort: "low",
  autocompact: WINDOW })` is the workflow tuning cost per turn. That is runtime policy
  living in process code.
- **Reconciliation.** "Keep no state the workflow can re-read" (design-workflow skill) means
  every workflow must be written as a reconciler against a moving world. That is a hard
  discipline that took weeks to get right in `open-pr.ts` and it is invisible to a reader.

This is why the examples are unreadable and why tweaking took weeks: the process is 5% of
each file and the mechanics are 95%.

## Core issue 2: process = TypeScript is the barrier to "just explain it"

The README's founding thesis: "You're stuck describing logic in prose. Code doesn't fall
apart." That was a fair bet when it was made. It has two costs now:

1. The only way to express a process is code against a typed adapter surface. So the
   person who wants a business process must be a programmer, or an agent must write
   correct TS and pass three review rounds (`make-workflow.ts` is exactly that, and it
   needs three skills and a reviewer to do it).
2. The bet is weaker than it was. Models in 2026 follow multi-step prose procedures with
   loops and conditions reliably. What prose still cannot do well is *deterministic*
   things: run the tests, compute a diff, poll an API. v1 drew the line at "the whole
   workflow is code." The right line is "the deterministic steps are code, and the system
   writes that code, not the user."

The insight buried inside the thesis survives: determinism where it is cheap, judgment
where it is needed, and an explicit signal when a human is required. The failure is in
where the boundary sits and who has to maintain it.

## Core issue 3: the human is the event loop, by construction

There are 28 `view.ask` call sites across 13 files in the starter catalog. Each one:

- blocks the run until answered,
- was placed by the workflow author at write time, with no notion of stakes, reversibility,
  the person's availability, or whether the agent could have decided,
- assumes the person has context, because they started this run minutes ago
  ("approve keeps them. Anything else is the lines to keep instead." is a REPL prompt).

There is no way to pre-answer, to set a standing policy ("always approve a split"), to
defer, to batch, or to take a default after a deadline. Every ask is a fresh interrupt
that arrives as an OS notification (`use-needs-you.ts`). The "needy" feeling is not a
tuning problem. It is guaranteed by the design: a run cannot progress past an ask, and
the number of asks is fixed by the author, not by the situation.

Your assumption that automated work will feel needier is right, and the mechanism is
this: today every ask lands on someone who has the context loaded because they just
pressed start. Remove that, and each ask costs a context switch. The fix is not fewer
asks in the code. It is asks as a first-class object with stakes, defaults, deadlines,
batching, and promotion to policy. v1 has none of that.

## Core issue 4: there is no memory, because git was the memory

"The world is the state store for the world" works because git and GitHub are excellent
databases for software work. `host.state` exists as a folder, but nothing structures it,
and no workflow uses it as memory. A marketing researcher or a business analyst has no
git. Nothing in v1 can hold: what we tried last month, what the numbers were, what the
customer said, which experiment is running. Without a ledger, an autonomous role starts
from zero every time and can only report, never build.

Related: skills are static. `~/.penguin/instructions.md` is the one place a person's
preferences go. Weeks of tweaking skills by hand happened because nothing feeds an
outcome back into the instructions. The system never learns from a correction.

## Core issue 5: everything runs on the laptop

Runs are child processes of the desktop app (`spawnRun` in `run.ts`, pid files, SIGINT
semantics, zombie detection in `lib.rs` with three OS-specific `process_argv`
implementations). Adapters shell out to local `git`, `gh`, `claude`, the macOS keychain via
`bun secrets`, local worktrees, and a Tauri webview for the browser. Auto-resume after a
usage limit lives in a React hook (`use-auto-resume.ts`), so it only happens while the app
is open. Close the lid and every run is "interrupted".

This is the opposite of "agents have their own computer," and it is also why nothing can
run on a schedule: there is no process that outlives the app.

## Core issue 6: the CLI is a demo, not an API

`examples/run.ts` runs one workflow in the foreground with readline prompts. The real
frontend is Tauri, and a meaningful set of capabilities exist only in Rust IPC: `read_runs`,
`stop_runs`, `pause_runs`, `resume_run`, `forget_runs`, `rename_run`, `read_run_log`, browser,
diff, servers. An agent cannot list projects, start a run with params, answer an ask, add a
catalog, set config, or read the gates without either the app or writing run files by hand.
"Every frontend reads and writes those files" is true, but nobody built the frontend an
agent would use.

## Core issue 7: the adapter model does not scale to "any business process"

`gh.ts` is 586 lines, `git.ts` 563, `jira.ts` 317, each a hand-written typed API over one
service. A business needs Stripe, App Store Connect, Google Analytics, Shopify, a mailer, a
CRM, a browser. Hand-writing a typed adapter per service is a full-time job, and meanwhile
the agent CLIs already have tool and MCP ecosystems that the adapters explicitly turn off
(`settings: []`). v1 is competing with the agent's own tool layer instead of using it.

## Issues you did not mention

- **Six agent adapters** (`claude.ts` 435 lines, `codex.ts` 373, `opencode.ts` 286,
  `copilot.ts` 274, `cursor.ts` 264, `pi.ts` 236), each parsing a different CLI's stream
  format. Roughly 1,900 lines of maintenance that is orthogonal to the product. Plus
  `jev.ts` and `helpers/jev.ts` (2,400 lines of code screening) and the exam subsystem
  (1,400 lines). Most of the repo by volume is software-dev-specific infrastructure that
  v2 does not need.
- **No budgets.** Cost is computed after the fact (`helpers/spend.ts`, the exam table).
  Nothing caps what a run may spend. An autonomous role running at 3am with no budget is a
  credit card risk, not a leverage story.
- **Identity.** Agents act as you: `gh` as `@me`, commits under your name, your keychain.
  A scheduled QA or marketing role posting as you with your credentials, with no audit
  trail beyond run.jsonl, is a problem the moment it runs unattended.
- **No way to trust before delegating.** There is no shadow mode, dry run, or "run it but
  do not act" for a whole process. `exam.ts` grades skills, which is the right instinct at
  the wrong granularity. Autonomy has to be earned per process, and v1 has no ladder.
- **Observability is per run, not per outcome.** The app shows transcripts and tool calls,
  which is a debug view. There is no "what is the state of the business," "what did QA
  find this week," or "what is waiting on me across everything, sorted by stakes."
- **Single person, single channel.** `view.ask` and `view.listen` assume one person at one
  desktop. A business owner is on a phone, in email, in Slack. Nothing routes a decision to
  where you are.
- **The docs already drifted.** `docs/` holds two generations (`00-index.html` through
  `07-reference.html`, and `index.html`, `engine.html`, `workflows.html`, `adapters.html`).
  A model that needs explaining twice is a model that is too heavy for its job.
- **Catalog resolution is deep for what it buys.** Project, home, enabled catalogs, sibling
  worktree checkouts, builtin, with shadowing rules per role (`catalogs.ts`,
  `catalog/README.md`). This exists so a workflow on a branch can run before merging. It is
  clever and almost nobody will ever need it.

## What v1 got right, and v2 should keep as ideas

- An ask is typed. The shape is the input system. A frontend renders whatever fits.
- An ask can be withdrawn when its premise dies (`{ until }`, `isWithdrawn`).
- Answers are data, refusals are faults, and the engine, not the workflow, holds the gate.
- The run journal replays answers and agent results, so a resume never asks twice or
  pays twice.
- Gates: the repository's own quality checks, found once, run by the system between
  turns, never by the agent.
- Skills as the craft layer, separate from control flow.
- Briefs: a rendered page a person approves from, instead of a wall of text.
- The founding question, "when is the human needed?", is the right question. v1 answered
  it at the primitive level and never at the policy level.
