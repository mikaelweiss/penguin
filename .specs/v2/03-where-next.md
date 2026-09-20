# Penguin v2: where we go from here

A from-scratch engine and client, with v1's adapters, UI package, and
discipline carried over. This is the shape, what to keep, what to drop,
and the order to build it in. Implementation detail is kept to what changes
the shape.

## The shape

One long-running service. Everything else is a client of it.

    ┌──────────────────────────────────────────────────────────────┐
    │  clients:  penguin CLI   desktop   (later: web, slack)        │
    └───────────────────────────────┬──────────────────────────────┘
                                    │  one API
    ┌───────────────────────────────┴──────────────────────────────┐
    │  service                                                      │
    │    events     schedule, webhooks, polls, person, other steps  │
    │    engine     processes × instances, one step at a time       │
    │    roles      identity, memory, tools, authority, budget      │
    │    inbox      what the person owes, with defaults and digests │
    │    store      event log + current state, the system of record │
    │    machines   where a step's work runs: local, container, VM  │
    └───────────────────────────────┬──────────────────────────────┘
                                    │  adapters (v1's idea, kept)
    ┌───────────────────────────────┴──────────────────────────────┐
    │  the world:  github, git, jira, email, browser, an agent...   │
    └──────────────────────────────────────────────────────────────┘

The service is the thing that exists when nobody is looking. It can run on
the laptop for a start, but it is written as if it lives on a small server,
because for the QA and research cases it will.

The CLI is the reference client and the first one built. If a thing cannot
be done from `penguin <verb>`, it does not exist yet. The desktop is a
second client and comes last. An AI agent operates penguin through the CLI
with `--json`, the same way a person does without it.

## Processes are data, not functions

A process is a structured definition with a small vocabulary. Prose is how
you author it. The definition is what runs. The AI compiles one to the
other, and can edit either through the CLI.

The vocabulary, and the whole of it:

| Step       | Who runs it     | May do                                           | May not do            |
| ---------- | --------------- | ------------------------------------------------ | --------------------- |
| `on`       | the service     | start an instance from a schedule, an event, a person, or another process's step | anything else |
| `do`       | the service     | call an adapter or a script, deterministically; branch on the data it returns | call a model, ask a person |
| `judge`    | a role          | one agent turn with a typed input and a typed output, using the tools its authority allows | touch the world past its authority, ask a person directly |
| `decide`   | the person      | one inbox item with a default and a deadline    | block forever         |
| `wait`     | the service     | park the instance until an event or a time      | poll in a loop        |
| `emit`     | the service     | raise an event other instances can `on`         |                       |

That is six words. `review-pr.ts` in this vocabulary is a page: `on` a PR
that asks for review, `do` fetch it, `judge` the review, `decide` whether to
post with a default of post-after-an-hour, `do` post, `wait` for the next
push or the close, loop. The eight states and six events that took 533
lines of racing promises are the engine's job, once, for every process.

The definition is explicit about the boundary the goal file describes: a
`do` cannot reach a model, a `judge` cannot reach the world except through
declared tools, and only `decide` reaches the person. That boundary is
enforced by the engine, not by convention.

Prose stays the source. `penguin process compile <file.md>` produces the
definition; `penguin process explain <name>` produces prose back from it. A
process you cannot read back as a page of prose is one the compiler got
wrong, and that is the test.

There is one escape hatch: a `do` step may run a script (TypeScript, with
v1's adapter host). That is where anything the vocabulary cannot say goes,
and where v1's helpers live on. It should be rare, and the CLI should say
how many a process uses.

## Instances hold state, the engine moves them

An instance is a record: which process, which step it is on, what each step
returned, what it is waiting for, what it has spent. The engine takes one
event at a time and moves one instance one step. Every step is idempotent
against its event id, so the same webhook twice moves nothing twice. There
is no replay journal because there is no long-lived function to replay. A
service restart reads the store and carries on.

This is what fixes "does not hold state well". A PR getting a new push is an
event; the instance waiting on that PR is the one that moves. Nothing races.

## Roles are principals

A role is a named agent, defined once, used by many processes:

- **Instructions**: who it is, what it cares about, in prose.
- **Memory**: a folder it owns and keeps notes in across instances. The
  weekly researcher reads last week before it starts this week.
- **Tools**: the adapters it may call, each with an authority level.
- **Authority**: per action class, one of `propose` (goes to the inbox),
  `act and report` (does it, shows up in the digest), `act` (does it
  quietly). This ladder is how trust is grown one notch at a time.
- **Budget**: tokens and money per day and per instance. The engine stops
  the step when it is spent, and that is a `decide` for the person.
- **Machine**: where its `judge` steps run. Local, a container, or a remote
  box with a browser and a checkout. The role declares what it needs; the
  service provisions.
- **Credentials**: its own, scoped, never the person's login.

`penguin role add qa` and `penguin role show qa` are the whole interface.

## The inbox is the only way to reach the person

Every `decide`, every `propose`, every budget stop, every fault the fixer
could not clear lands in one inbox. Every item carries:

- what it is about, in one line, with a link to the instance,
- the default the process declared, and when it happens,
- the two or three answers that make sense, plus free text.

The person sets a digest cadence. Nothing interrupts outside it except an
item flagged urgent by the process definition, and the compiler should
refuse to flag more than a handful. `penguin inbox` lists, `penguin inbox
answer <id> <answer>` resolves, and the desktop's main screen is this list.

This is the whole answer to "needy". The number of agents does not matter;
the number and shape of the items that reach you does.

## Adapters: keep the idea, cut the sprawl

Keep from v1, nearly as is: the adapter contract (role, name, build(host),
plain data, `Fault` for refusals, `check` for preflight), and the git, gh,
and jira adapters.

Add: schedule, webhook, email, browser, filesystem on a machine.

Cut: five of the six agent adapters. Pick one runtime, the one with a stable
programmatic API and structured results, and make the agent adapter thin.
The screening adapter and the exam workflows go too; evaluation is an
artifact every `judge` leaves, not a separate process.

## Machines

A `judge` step declares what it needs: a checkout of a repo, a browser, a
build of the app, a long wall clock. The service matches that to a machine
the role is allowed to use. Start with two: the local machine, and one
container image with a browser and the toolchain. A remote VM is the same
interface with a different provisioner and comes when the QA process needs
it.

The important design choice is that machines are the service's, not the
person's. A step that needs a computer never needs yours.

## What is dropped from v1

- The workflow-as-function model, `run.ts`, `trace.ts`, `child.ts`, the
  replay journal, and child runs as processes.
- The catalog's worktree scanning and everything git-shaped in the loader.
- The desktop as a run viewer: transcript, terminal host, files panel,
  review tab, browser panel. A drill-in view of one instance will exist,
  and it will be a log, not a session.
- `make-workflow`, `exam`, `jev-exam`, and the skills that serve only them.
- Five agent adapters and the screening adapter.

## What is carried over

- `packages/ui` and the shadcn rules, for the new client.
- The adapter contract and the git, gh, jira adapters, ported to the new
  host.
- The skills catalog format, now attached to roles.
- `Fault`, the gate, the bounded fixer, and preflight `check`.
- The docs discipline: one page that explains the model, and code that
  matches it.

## Order of work

Each phase ends with something usable from the CLI and a process running
end to end. No phase is UI.

0. **Vocabulary on paper.** Write the six-word definition format. Write
   three processes in it by hand: weekly QA, PR review, weekly research
   report. If any is longer than a page or needs a script step, the
   vocabulary is wrong, and this is the cheapest place to find out.
1. **Service, store, engine, CLI.** Processes as data, instances in a
   store, one event loop, `penguin process|instance|event` verbs. One
   adapter (gh) and one role runtime. PR review runs end to end from a
   webhook or a poll, survives a restart, and never asks a person.
2. **Roles and the inbox.** Authority ladder, budget, memory folder,
   digest. PR review now posts with `propose`, and the person answers from
   `penguin inbox`. Run it for real on this repo for two weeks.
3. **Schedules and a second domain.** `on schedule`, email or a document
   adapter, and the weekly research process for the side business. This is
   the first process with no repo, and the one that proves the vocabulary
   is not software-shaped.
4. **Machines.** The container provisioner, a browser adapter, and the
   weekly QA process running while the laptop is closed.
5. **Prose compiler.** `penguin process compile` as a process itself: a
   role reads the prose, writes the definition, a `decide` shows the person
   the explain-back. Only now, because the vocabulary has to be settled
   before an AI writes to it.
6. **Desktop.** Inbox first, then a digest, then an instance drill-in. On
   `packages/ui`, from the CLI's API, nothing else.

## Two honest cautions

**Starting from scratch is right for the engine and the client, and wrong
for the adapters and the discipline.** Port those. The temptation will be
to rewrite them "properly" and lose a month.

**The vocabulary will want to grow.** Every process will suggest a seventh
word. Refuse it until three processes need the same one. The value of v2 is
that a process is a page an AI can write and a person can read; every word
added makes both harder.
