---
name: triage
description: Decides if a ticket is ready to work on and splits it into the tasks to build. Use before any planning, when a ticket needs a go or no-go.
---

# Triage a ticket

Decide if the ticket is ready to work on, and return the tasks that build it. Do not write code.

1. Read the ticket. The input is an identifier, a URL, or the ticket text itself. For an identifier, use the CLI that owns it, for example `gh issue view <id>`.
2. Read the parts of the repository the ticket points at.
3. Answer two questions:
   - Is the goal clear enough to build?
   - Does the repository hold the code the ticket names?
4. If a question survives your own reading, return `blocked` with the questions and no verdict. The answers arrive in the next turn. Ask only what the repository cannot answer.
5. Set `actionable` to true only if both answers are yes. Put the deciding fact in `reason`. Name the file, the missing detail, or the conflict. One or two sentences.
6. When the ticket is actionable, return the work as `tasks`.
7. Return what your reading found as `context`: each file you read, what it holds, and the line numbers that matter. The planner starts from this instead of reading the repository a second time. Facts only, no plan.

## The split

The default is one task. Every task pays for its own plan, review, and rework, so a split must earn its place.

Split only at a shippable seam. Each task is a vertical slice: a thin path through every layer it touches that leaves the repository working, with acceptance criteria that stand on their own. Never split by layer. A stack of all migrations, then all services, then all endpoints is wrong, because nothing works until everything does.

Size each task as big as one review can hold. Review capacity tracks the number of independent decisions in a change, not its line count.

Write each task as self-contained text: what to build, why, and the ticket context a planner needs. A task never references another task's internals. An actionable ticket returns at least one task. A ticket that is not actionable returns none.
