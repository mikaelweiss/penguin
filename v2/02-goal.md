# What penguin v2 is for

Not a restatement of the brief. This is the root, as I read it, and why it matters.

## The root

You are buying back attention. That is the whole product.

You have a side business and roughly zero spare cognitive capacity after work. Two
in-flight tasks you started yourself already feel like too many. So the scarce resource is
not compute, not agent capability, and not money in the first order. It is minutes of your
focused attention per week, and the number of times something pulls you out of whatever
you were doing.

Every tool that promises "AI runs your business" optimizes for capability: more things it
can do. None of them treat "how many decisions did this cost the owner this week" as the
number to drive down. That is the gap, and it is the gap v1 accidentally proved: penguin
felt fine at work because you were already at the keyboard with the context loaded. The
moment work starts without you, every interruption costs a full context switch, and the
same design becomes unbearable.

So the goal is not "autonomous agents." Autonomy is the means. The goal is:

> A business that produces outcomes with a small, bounded, predictable draw on your
> attention, where each draw is worth it.

## What follows from that

**The unit of value is an outcome, not a run.** "Regressions found and filed this week."
"Three growth experiments run and measured." "A memo on where the business should go next
quarter." A run is how it happens. You should never have to look at one unless something
went wrong.

**You configure intent and boundaries, not procedure.** What the business is. What
matters. What a role is for. What it may not do without you. How much it may spend. The
procedure is the system's to work out, to write down, and to improve. When you want to
change something, you say so in words, and the words are the source of truth.

**Your attention is an inbox of decisions, and the inbox is designed.** Each decision
arrives pre-chewed: the context, the options, a recommendation, a default, what happens if
you ignore it. Decisions batch to your cadence. Silence is a valid answer, because there
is a default and a deadline. An answer can become a standing policy so it is never asked
again. The count of decisions per outcome is a metric the system reports and tries to
lower.

**Trust is earned per process, and revocable.** A new process runs in the open first: it
does everything except act, and shows you what it would have done. You promote it. It can
lose the promotion on a failure or a budget breach. This is how you get to autonomous
without a leap of faith.

**The primary operator of penguin is an agent, not you.** You are a stakeholder. An agent
sets up processes, runs them, checks on them, reads memory, answers what it is allowed to
answer. That is why every capability has to be reachable from a CLI: the CLI is not a
convenience for you, it is the API for the thing that actually runs the business.

**The business runs when the laptop is closed.** Roles have their own machines, with a
browser, with credentials scoped to what that role may touch. The laptop is a window, not
a host.

**Memory accumulates.** A role knows what it tried, what the numbers were, what you
decided last time. The analyst reads what the growth role measured. Without this, every
run starts from zero and can only report, never compound.

## On "employees" and "processes"

The reframe from workflows to roles is right, for a specific reason. A role is the natural
place to hang the things v1 had nowhere to put:

- a standing identity and credentials that are not yours,
- a budget,
- a memory,
- standing instructions and preferences, which is where your corrections land,
- a schedule and a set of triggers,
- a trust level.

A workflow has none of those because it is a function. A role persists. That is the
difference that matters. Be careful not to turn it into an org chart with headcount: the
useful content of "employee" is exactly the list above, nothing more.

A process is then just: which role does what, when, and where the handoffs and the human
gates are. Written in prose. Owned by the system once you have described it.

## What is not the goal

- Not a general agent framework. One business, one owner, opinionated.
- Not a workflow language. If you are writing control flow, v2 has failed.
- Not a multi-CLI abstraction layer. Pick one agent runtime and build on it.
- Not an IDE or a desktop app. A UI may exist, but it is a client, and it comes last.
- Not "do everything a human could do." Do the bounded, repeatable, judgment-light
  majority, and route the rest to you cleanly.

## How you would know it works

- Minutes of your attention per week, and its variance. Predictable beats low.
- Decisions per week, and what fraction took the default.
- Outcomes delivered per week, per role.
- Dollars per outcome, against a budget you set.
- Time from "I explain a process" to "it ran once in shadow mode" (target: same sitting).
- How often you open a run transcript. Lower is better. It means you did not need to.
