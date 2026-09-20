# Penguin v2

Start from scratch, with transplants. The engine, the desktop, and the example
catalog are all shaped by "a run is a program a person starts". None of them
survives as a base. Specific parts survive as organs.

## The shape

### One daemon, one API, two clients

`penguind` is always on. It owns the event log, the state store, the scheduler,
the process runtime, and the machine pool. It runs on your Mac first and on a
small server later. Nothing else holds state.

`penguin` is the CLI. It is the complete surface: every noun below has
`penguin <noun> list|show|create|...`. Agents use the CLI. The desktop uses the
same API and adds nothing the CLI cannot do. The CLI is the contract; the
desktop is a window.

### The nouns

**Organization.** The business. One per install. Owns memory, roles,
processes, and policy.

**Role.** An employee. Has:

- a charter (prose: what this role is for, how it thinks)
- tools (which adapters it may use, with what scope)
- a machine (where it works)
- an identity (its own GitHub account, its own email, its own API keys)
- a budget (money per day, and what happens when it runs out)
- a policy (what it decides alone, what it escalates, defaults and deadlines)
- a model tier for work steps

Roles pick up steps in processes. A process step says "the QA role does this",
not "run claude with this prompt".

**Process.** A definition. Triggers, steps, handoffs. Authored by describing
it in conversation. Stored as a readable spec, short enough to fit on one
screen, plus an executable form the runtime runs. Steps are typed, and the
types are exactly the four kinds of decision in the goal document, plus
plumbing:

- `script`: deterministic code over adapters
- `judge`: a typed question to a System One model
- `work`: a role does something on its machine and returns a typed result
- `ask`: a person, under the role's policy
- `wait`: for an event, with no thread held
- `emit`: an event other processes may pick up
- `call`: another process

**Instance.** One process running. Durable, resumable, inspectable, and never a
thread. An instance waiting on an event is a row in a table, not a parked
process. This replaces "run".

**Event.** Everything that happens. External (a webhook, a schedule, a poll an
adapter does on the daemon's behalf) and internal (a step finished, an ask was
answered, a budget was hit, memory changed). Persisted, addressable, replayable.
Processes subscribe by pattern. A new push on a PR is an event; the process
that cares wakes; nothing else moves.

**Ask.** An item in your inbox. Carries: the role asking, the instance, what
was seen, the recommendation, the options, the default, the deadline, and what
happens if the deadline passes. One inbox across the whole organization.
Batched into a digest at a cadence you set, unless a judge marks it urgent.

**Machine.** A sandbox a role works in. A local container first, a VM later.
Provisioned by the daemon, holding the role's credentials and not yours. Browser
automation, test runs, and long research live here. Your laptop is one machine
in the pool, and the default is that it is not used.

**Memory.** What the organization knows. Markdown under version control for
the readable part (what the business is, who the customers are, decisions and
why), plus a structured store for facts processes read and write. Roles read it
in every work step. Only processes write it, through steps, so every change is
traceable.

**Adapter.** The v1 idea, kept whole: a bridge to one outside thing, functions
over plain data, answers are data and refusals are faults. Two additions: an
adapter may subscribe (turn the outside thing's changes into events, so polling
lives in the daemon once instead of in every process), and an adapter runs on a
machine, with that machine's credentials.

**Skill.** Unchanged. Craft for work steps, in the Agent Skills format.

## Authoring: the compiler

The v1 `make-workflow` had the right instinct and the wrong output. It produced
a 300-line TypeScript file that then needed weeks of tuning. In v2 the
conversation produces a spec, and the spec is the source of truth.

The spec is small on purpose. A process reads like this:

```yaml
process: weekly-qa
trigger: every monday 06:00
steps:
  - script: build.deploy_preview      -> preview
  - work: qa.regression               with: preview  -> report
  - judge: report.has_regressions?
    yes:
      - judge: report.severity        (low, medium, high)
      - script: github.issue.create   with: report
      - ask: qa.escalate              if: severity >= high
    no:
      - emit: qa.green
```

The rules the compiler enforces are the rules from the goal document. A step
that could be a script is not allowed to be work. A judge must list its
answers. An ask must carry a recommendation, a default, and a deadline, or the
role's policy supplies them. A process with more than a screen of steps is
split. A reviewer role checks every new spec against the organization's policy
before it is enabled.

TypeScript does not go away. It is the executable form the compiler emits,
and it is the escape hatch for a `script` step the spec language cannot say.
The difference from v1 is that you never author or maintain the TypeScript. You
maintain the spec, and the spec is a page.

## Where the System One model goes

Jev, or whatever System One model is current, is the default for every `judge`
step, and the runtime uses it in four places of its own:

1. **Inbound triage.** Every comment, email, ticket, review, and message is
   judged before anything else sees it: does this direct anyone to anything,
   which role, how urgent. v1's `triage.feedback` is this, generalized.
2. **Escalation.** Before a role acts, its proposed action is judged against
   its policy: does this fall inside what the role decides alone. Confidence
   below the threshold escalates; above it acts and logs.
3. **Inbox shaping.** Is this ask urgent or does it wait for the digest. Can
   two asks be merged. Given your past answers, what would you say (shown as
   the recommendation, never acted on alone).
4. **Acceptance.** Is this step's result what the process asked for. A cheap
   check before an expensive retry.

The usage rules, from what is published about the model: keep the state small
and filter it in code first, since accuracy drops as irrelevant state grows and
the window is about 32k tokens; only ask questions whose answers are known up
front; never use it to generate text or explain itself; pin the model version
because `jev-latest` moves and thresholds drift with it; log every answer with
its probability and the eventual outcome, so thresholds are tuned from data.
The v1 exam harness is exactly the tool for that last part.

v1's Jev adapter is 2,400 lines because every question is code. In v2 a
judge is data: a question, its answer set, its threshold, and its state
selector, stored beside the process that uses it and editable by the compiler.

## Attention design

This is the part that makes it not needy, and it is policy, not UI.

- Every role has a policy: decide alone, decide and report, ask with a default,
  ask and wait. Per kind of action, with money and irreversibility always in
  the last bucket until you move them.
- Every ask carries a recommendation and a default. If the deadline passes, the
  default happens and you are told.
- Asks batch into a digest at your cadence. Only a judged-urgent ask breaks
  through.
- The inbox is one queue, ranked. Not one per process, not one per role.
- Every decision, autonomous or yours, is logged with what was seen. You can
  audit, and the audit feeds the metrics.
- The desktop's home screen is the five metrics from the goal document. If
  attention per week goes up, something is wrong, and you can see which
  process did it.

## Machines and identity

v1 assumed "runs on your computer, as you". v2 assumes "runs on the role's
machine, as the role". The daemon provisions a container per role (local
first, a cheap cloud box second), installs the role's tools, and injects the
role's credentials. Work steps run there. On a machine, agents are driven
through SDKs and APIs, not through six CLI stream parsers.

Your laptop can be a machine in the pool for processes that genuinely need it,
and that is opt-in per process.

## Transplants from v1

Take whole, with light rewrites:

- The adapter model and the git and GitHub adapters' logic
- Faults versus answers, and the gate that holds a fault for a fixer
- Typed agent turns with schema validation
- Skills, as they are
- The journal format, as the instance event log
- Gates, as `script` steps
- The exam and score harness, pointed at judges and asks as well as skills
- The scout-before-work pattern
- The Jev question design, as data instead of code

Drop:

- Workflow-as-TypeScript as the thing a person writes
- Process-per-run and every piece of pid, argv, and zombie logic
- The view-as-adapter file inbox
- Pause and resume by replaying the transcript
- The desktop's file browser, terminal, browser panel, and review panel
- The six agent CLI adapters, replaced by SDK-driven agents on machines

## Sequence

**Phase 0: paper.** Write the spec format and three processes in it: weekly
QA, PR steward, marketing researcher. Check every step is one of the four
kinds. If a step does not fit, the model is wrong and this is the cheapest
moment to find out. No code.

**Phase 1: daemon, CLI, events, instances.** The first always-on process is
the PR steward, ported from `open-pr` and `pr-queue`, with the reactor moved
into the runtime. Success is that it runs for a week without a laptop being
open, and that everything it did is visible from the CLI. No desktop.

**Phase 2: roles, inbox, policy.** One role with a policy, one inbox, one
digest. Success is the first week where attention per week is measured.

**Phase 3: the compiler.** Describe a process in conversation, get a spec,
enable it. Success is the marketing researcher process going from description
to first run in under an hour.

**Phase 4: machines.** A container per role. Success is the QA process running
a browser on a machine that is not yours.

**Phase 5: the desktop.** Inbox, metrics, organization, processes, instances.
Thin.

## Risks and open questions

- Running on a server moves secrets off your machine. Per-role credentials
  make the blast radius small, but this is a real design problem for the
  daemon and needs deciding before Phase 4.
- Jev is early access and its limits and versions move. The judge layer must
  be an interface with a pinned version behind it, and every threshold must
  come from logged outcomes, not from guesses.
- The spec language will hit an expressiveness ceiling. The TypeScript escape
  hatch keeps that from blocking, but the ceiling should stay low on purpose:
  a process that needs the escape hatch often is a process that should be
  split.
- Budgets need a real floor. A role that runs out stops, tells you, and
  nothing else happens. Autonomy without that is a bill.
- The temptation to rebuild the IDE. The desktop stays a window onto the
  inbox and the metrics. Watching work is opt-in and rare.
