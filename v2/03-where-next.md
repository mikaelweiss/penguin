# Penguin v2: the shape

Starting from scratch is the right call. Almost nothing in the v1 code is the right shape
for v2, and the parts worth keeping are ideas, not files. This document is the shape, not
the implementation. Where it names a technology, that is a shape decision, not a detail.

## The five bets

1. **Processes are prose.** You describe a process in words. The system interprets it,
   writes down what it understood, and follows it. Deterministic steps (run the tests,
   pull the numbers, poll an API) are code the system writes and owns as internal
   artifacts. You never see them unless you ask.
2. **Roles own work.** A role is a persistent thing with identity, credentials, budget,
   memory, standing instructions, triggers, and a trust level. Every task belongs to a
   role. Roles are the answer to "who did this, with what, and why was it allowed."
3. **Decisions are the product surface.** The ask from v1 becomes a first-class object
   with stakes, options, a recommendation, a default, a deadline, and a place in an inbox.
   How well this works is the whole ballgame. Build it early and design it hard.
4. **A daemon runs it, on a machine that is not your laptop.** Triggers, schedules, task
   lifecycle, budgets, the inbox, and memory live in a service. Each task runs in its own
   sandbox with the role's credentials. The laptop is a client.
5. **The CLI is the API and it comes first.** Every noun has list, show, create, update,
   remove, with `--json`. The daemon exposes it. Any UI is a client of it. If the UI can do
   it and the CLI cannot, that is a bug.

## The nouns

Few, and each one is a folder of plain files in one git repo per business, so agents, the
CLI, and you all read and write the same thing.

- **Business.** The root. A description of what the business is, what matters, what is
  off limits, the cadence you want to be bothered on. Everything else lives under it.
- **Role.** Name and charter in prose. Standing instructions (where corrections
  accumulate). Permissions: which tools, which credentials, what spend. Budget per week.
  Memory folder. Trust level. Examples for your business: QA, Growth, Analyst, Engineer,
  Support.
- **Process.** A prose document: what triggers it, which role starts it, what the steps
  are, where it hands off to another role, where it must stop for you. Plus its trust
  level and its history of runs.
- **Trigger.** A schedule, a webhook, a watch (a PR, an inbox, a metric crossing a line),
  or another process finishing. Owned by the daemon, never by a running task.
- **Task.** One piece of work in flight: a process instance, owned by a role, in a
  sandbox, with a journal, a cost, and an outcome. This is v1's run, but it is started by
  a trigger and owned by a role, and you rarely look at it.
- **Decision.** What a task needs from you. Stakes, options, recommendation, default,
  deadline, and what happens on silence. Answerable from the CLI, the inbox, or wherever
  you are. An answer can be promoted to policy with one flag.
- **Memory.** Per role and shared. Structured where it pays (metrics, experiments,
  customers, tickets) and notes where it does not. Agents read it before asking you
  anything.
- **Outcome.** What a process produced, in a form you would read: a filed bug list, an
  experiment result, a memo, a merged change. The weekly digest is a list of these.

That is it. No workflow, no adapter, no catalog. Tools are the agent runtime's tools.

## Attention design rules

These are the rules that make it not needy. They are product rules, not code rules.

- A task exhausts the cheap options before it asks: re-read the world, check memory,
  check standing policy, try the reversible thing. An ask without that is a defect.
- Every decision carries a recommended default and a deadline. After the deadline the
  default is taken, or the task parks harmlessly, whichever the process says. Silence is
  an answer.
- Decisions batch to your cadence. One digest at a time you choose. Only a decision marked
  urgent by a rule you set gets through outside that.
- Any answer can become a standing instruction on the role, so the same question is never
  asked twice.
- The system reports decisions per outcome, per role, and treats a rising number as a
  problem to fix, not a fact of life.
- A weekly review: what was done, what was spent, what is waiting, what the roles
  recommend changing about their own processes. You read one page.

## The trust ladder

Every process has a level, and you move it:

1. **Shadow.** Runs on schedule, changes nothing, reports what it would have done.
2. **Supervised.** Every action becomes a decision before it happens.
3. **Bounded.** Acts inside explicit limits (spend, scope, blast radius), reports after.
4. **Autonomous.** Acts, and appears only in the weekly digest.

Promotion is yours. Demotion is automatic on a failed gate, a budget breach, or a
correction you make twice.

## What "just explain it" looks like

You say, in the CLI or a chat: "Every Monday I want a QA pass on the app looking for
regressions, and anything it finds should become a ticket." Penguin's operator agent:

1. Drafts a role (QA) if none fits, a process document, a trigger, and a trust level.
2. Shows you one page: here is what I understood, here is what it will do, here is what it
   will ask you and when, here is what it may spend.
3. You say ok. It runs once now, in shadow, and you get the report.
4. You promote it. From then on it appears as outcomes in your Monday digest.

Every later change is a sentence: "stop filing cosmetic issues," "also check the marketing
site," "let it fix the obvious ones itself." The sentence edits the prose; the prose is
the process.

## Where the agents run

Each task gets a fresh sandbox: a container or small VM the daemon provisions, with the
repo, a browser, and only the credentials the role is allowed. Cloud first, so nothing
depends on your machine, and so QA can drive a real browser at 3am. Task journals stream
back to the daemon so a task can be watched, paused, or resumed the way v1 runs can. Keep
v1's replay idea: a resumed task never re-asks or re-pays.

Build on one agent runtime rather than adapting six CLIs. The Claude Agent SDK already
has sessions, skills, structured output, hooks, and tool ecosystems, and v1's `claude.ts`
adapter is mostly a re-implementation of what the SDK exposes directly. This alone
removes several thousand lines from the v1 surface.

## What to carry over from v1

As ideas, and in a few cases as small pieces of code:

- Typed decisions with withdrawal when the premise dies.
- The journal and replay model for a task.
- Gates: the repo's own checks, found once, run by the system between agent turns.
- Skills as the craft layer, but now owned by roles and edited by the system from your
  corrections.
- Briefs: a rendered page to decide from, which becomes the decision's body.
- The answers-are-data, refusals-are-faults split, and the engine-owned gate.

## What to leave behind

- TypeScript as the process language, and everything that supports it: catalogs, the
  loader, sibling-worktree resolution, `penguin-env.d.ts`, `make-workflow`.
- Hand-written adapters per service. The agent's tools and MCP servers do this.
- Six agent adapters. One runtime.
- Jev and the exam harness. Good ideas for a code-review product, not for this.
- The Tauri desktop app as the primary surface, the terminal panel, the files panel, the
  browser panel. If a UI comes back, it is a web client of the daemon.

## Build order

Thin vertical slices. Each one is usable on its own and proves the next bet.

1. **Nouns and CLI, no daemon, no agents.** `penguin init`, `role add`, `process add`,
   `decision list`, everything as files in a git repo. An agent can already operate this.
2. **One task, one role, one prose process, in a sandbox.** The agent follows the process
   document. Journal and replay. Local container first, cloud second. This proves prose
   processes work before anything else is built on them.
3. **Decisions and the inbox.** Defaults, deadlines, batching, promotion to policy, the
   digest. This is the slice that decides whether v2 is needy. Do it third, not last.
4. **The daemon and triggers.** Cron, webhook, watch. Deployed on a cloud box. Now things
   run on their own.
5. **Memory.** Per-role, structured where it pays. Now roles compound instead of report.
6. **Trust ladder and budgets.** Shadow mode, demotion rules, spend caps, the weekly
   review.
7. **Migrate one real process** from v1 (the ticket-to-merged-PR flow) as a prose process.
   If it cannot be expressed, the bet is wrong and it is better to know here.
8. **A UI**, only if the CLI and digest turn out not to be enough.

## Risks to name now

- **Prose is less predictable than code.** Mitigations: shadow mode, gates as
  deterministic checks the system runs, the system writing internal scripts for the
  deterministic steps, and slice 7 as the proof.
- **Always-on agents spend money while you sleep.** Budgets are in slice 1's data model
  and enforced from slice 2. Non-negotiable.
- **Autonomous agents holding your credentials.** Roles get their own identities (a bot
  GitHub account, scoped API keys) and an allowlist of actions. Nothing runs as you.
- **Rebuilding the agent runtime.** v1 spent thousands of lines adapting CLIs. Do not.
- **Over-designing roles into an org chart.** A role is identity, memory, budget,
  permissions, triggers, trust. That is the whole definition.
