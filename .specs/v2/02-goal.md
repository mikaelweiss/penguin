# Penguin v2: the goal

Not a restatement of the request. This is my read of what is underneath it,
what to measure, and what v2 is not.

## The root of it

You want leverage: a system that runs the recurring work of a business, on
its own, well enough that you can own that business on the attention you
have left after a day job.

The scarce resource is not compute, and it is not even time in the raw. It
is attention, and specifically the cost of switching into a task you did not
start, loading its context, and making a decision. Every existing tool
optimizes for output per hour of an engaged operator. You need output per
minute of a distracted one.

So the north star is one ratio:

    business output / minutes of your attention

Everything in v2 either raises the numerator (more runs, more done, more
autonomy) or lowers the denominator (fewer interruptions, better-shaped
ones, defaults, digests). A feature that does neither does not belong.

## Why the existing things do not get there

Three families of tools, three failure modes:

1. **Chat-shaped agents** (a coding harness, a bot you message). Great
   judgment, no process, no state, no schedule. They are needy by
   construction, because the conversation is the state and you are the
   scheduler.
2. **Workflow builders** (Zapier, n8n, Make). Deterministic, event-driven,
   good state. No judgment, and the configuration is the product, so a
   complicated process is a complicated diagram you maintain by hand.
3. **Agent frameworks and v1 penguin**. Code, so anything is possible. But
   the author writes at the systems level, every process is bespoke, and
   the engineer is you.

None of them holds all three things at once: durable process state, real
judgment where it is needed, and an attention model for the owner. v2 is
the tool that holds all three, and the third one is the one nobody else
builds.

## What "runs my business" means, concretely

A business is a set of recurring processes. Each has a trigger (a schedule,
an event in the world, a person), steps that are mechanical, steps that
need judgment, and a small number of decisions that are genuinely the
owner's. That is true of a software team, a marketing function, a support
queue, and finance. The domain changes the tools and the vocabulary; it
does not change the shape.

v2 succeeds when you can:

- Describe a process in prose, once, and have it run on its schedule or its
  events without you touching it again unless it is wrong.
- Trust that the mechanical parts are mechanical: the same input produces
  the same step, in the same order, every time, and the AI never gets to
  skip a step it found boring.
- Trust that the judgment parts are held to a shape: a typed result, a
  bounded budget, a declared authority, an artifact you can audit later.
- Open one place, at a time you choose, and see what happened, what was
  decided for you, and the few things that actually need you, each with a
  default already chosen and a deadline after which the default happens.
- Give an agent a machine that is not yours, so the work that needs a
  browser, a build, or a long night runs while your laptop is closed.
- Do all of the above from a shell, so an agent can operate penguin the way
  you would, and so nothing is trapped behind a screen.

## Agents or workflows: which is the unit

Neither alone. Three things, each the unit of one concern:

| Concern         | Unit         | What it is                                                      |
| --------------- | ------------ | --------------------------------------------------------------- |
| Definition      | **Process**  | What should happen, triggered by what, in what order, with what checks. |
| Accountability  | **Role**     | A named agent: instructions, memory, tools, authority, budget, machine. |
| State           | **Instance** | One live occurrence of a process, with its current step and history.   |

You talk in roles ("my QA person found a regression"). The system runs
processes. The engine holds instances. A role can serve many processes; a
process can hand steps to several roles. This is how a company already
works, and it is the reason "employees" felt right in the blurb and
"workflows" felt wrong: v1 had processes and instances fused into one
function, and no roles at all.

## The automation and judgment boundary, as a rule

Deterministic, always: fetching, transforming, routing, scheduling,
deduplicating, retrying, recording, enforcing budgets and authority,
deciding whether a step ran. If a step can be a function, it is a function,
and a model never gets to do it.

Judgment, only: classifying something ambiguous, writing for a human,
investigating an open question, choosing between options when the criteria
are soft, noticing what was not asked. That is what a role does, and it does
it inside a step with a typed output and a declared authority.

The person: the decisions with real consequences that no default covers, and
the sampling of everything else. Every question that reaches you carries
what will happen if you say nothing.

This rule is the thing that keeps attention low. Every tool that mixes the
two produces noise, because a model doing a mechanical step makes mechanical
mistakes you have to catch, and a script doing a judgment step asks you the
question it cannot answer.

## Why build it, and why you

The engine half is already proven by v1: adapters as bridges, faults as
gates, typed agent turns, replayable traces. That was the hard, unglamorous
half and it works. What is missing is the operator half: durable state,
events, roles, an inbox, and a runtime that is not your laptop. Nobody
else's tool has an operator half designed around a person with twenty
minutes a day, because nobody else's tool is built by that person.

The side business is the forcing function. If v2 can run it on the attention
you actually have, it can run a team's processes at work with attention to
spare. The reverse is not true, and that is why the personal case is the
right one to design for.

## What v2 is not

- Not a workflow language for developers. TypeScript stays for adapters,
  tools, and custom scripts. It stops being how a process is authored.
- Not a coding agent harness. It will run coding processes, and it will not
  be judged on how nice the diff viewer is.
- Not a general agent framework. It is opinionated about what a step may
  be, what a role may do, and how a person is asked. Those opinions are the
  product.
- Not "any business process" on day one. It is a small fixed vocabulary
  that can express a QA loop, a PR review, and a weekly research report,
  proven on those three, then widened.
