# Where we go from here

v2 is a new product, not a new version of the engine. Start from scratch on
the model and the client. Bring the mechanical parts of v1 along where they
fit.

## Design the review before the runtime

Write, by hand, the weekly review you would want to receive from a
business that penguin runs. Not a mockup. The actual document for one
week: what each agent did, what it decided, what it spent, what it wants
from you, what it noticed. If reading it takes more than twenty minutes,
or leaves you with open loops, the design is wrong before anything is
built.

Everything else exists to produce that document and to act on what you
write back. It is the spec.

## The pieces

**The business context.** One shared body of knowledge every agent reads:
what the products are, who the customers are, where the accounts and tools
are, what quality means here, what you have decided before. Written once,
grown by the review. This is what makes a one-paragraph delegation enough.

**Agents with responsibilities.** An agent is a standing role: a goal, a
scope, a boundary, a rhythm, tools, credentials, a machine, a budget, and a
memory it keeps. It is defined in prose plus a few settings. It does not
finish. You add one the way you would hire one: describe the job, set the
boundary narrow, widen it as the record earns it.

**Procedures, small and rigid.** The sequences inside a responsibility
that must run exactly, every time, in order. A release checklist. A review's
steps. A data migration. These are the scripts. They are short because they
hold only what must not vary, and an agent runs them as a unit it cannot
skip or reorder. This is where v1's engine survives, cut down.

**The record.** Everything an agent does, decides, spends, and wants goes
into one ledger. It is the source of the review, the track record trust is
built on, and the audit trail when something is wrong. Nothing an agent does
is invisible.

**The boundary.** Per agent, per kind of action, one of: do it, do it and
flag it, propose it. The default is set by how reversible the action is,
and widened by the record. The system enforces it. Prose does not.

**The review.** Your one interface. Produced on your cadence from the
record. Every item that needs you carries a default and what happens if you
say nothing. What you write back updates the business context, the
boundaries, and the agents' memory. An urgent channel exists for the rare
thing that cannot wait, and its rarity is a metric.

**Self-sufficiency.** Agents run on their own machines with their own
identities and credentials, and reach information through the same tools
you would. The whole system is operable from a shell, so agents can operate
it, including setting up other agents and fixing their own tooling.

## What to keep from v1

- Adapters as deterministic bridges with plain data and faults. The git,
  GitHub, and Jira ones port directly.
- Typed results from agent turns.
- Faults as gates with a bounded fixer before a person.
- Skills as reusable instruction files, now owned by agents.
- The UI package and its rules, for the review client.
- The habit of one-page docs that the code matches.

## What to leave behind

- The run as the unit. Procedures become a small part inside a
  responsibility, not the thing you start.
- The supervised-execution client: transcript, terminal, diff viewer,
  panels. A drill-in from the review into the record replaces them.
- The replay journal, child runs as processes, and the git-shaped
  catalog.
- Six agent CLIs. One runtime with a stable API.
- The examples. They were written to be run by a person watching. New
  examples are responsibilities, and the first one is not software.

## Order

1. **The review, on paper.** One week, one business, written by hand.
2. **One responsibility, by hand, with you as the runtime.** Pick one
   for the side business. Write its goal, boundary, rhythm, and business
   context. Run it yourself for two weeks using a plain agent, producing
   the record and the review manually. This finds out what the agent needs
   to know and what you actually want to be asked. It costs nothing to
   build.
3. **The record and the review, automated.** The smallest service that
   holds the business context, runs one agent on its rhythm on its own
   machine, writes the record, produces the review, and takes your answers.
   Shell-operable. No procedures yet. No UI beyond the review document.
4. **Boundaries and the record as a track record.** The autonomy dial per
   action kind, enforced. Widen it on the side business for real.
5. **Procedures.** Port the cut-down engine for the rigid sequences, and
   move one software responsibility onto it. This is the point where a QA
   pass or a PR review joins, not before.
6. **A second agent, and agents that set up agents.** Prove that adding a
   responsibility is a paragraph.
7. **The review as a client.** Only when the document form is stable.

## Two cautions

**Build the operating model before the runtime.** The strong pull will be
to start with the engine, because that is the part that is understood. The
engine is not what was missing.

**The side business is the only test that counts.** If it does not run on
the attention you actually have after work, no amount of capability is
leverage. Measure interruptions per week from day one.
