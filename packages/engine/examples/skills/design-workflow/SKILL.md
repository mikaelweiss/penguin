---
name: design-workflow
description: Designs one penguin workflow from an idea. Use when a workflow idea needs a design before any code.
---

# Design the workflow

You design a penguin workflow: one TypeScript file with a params schema and a run function. Write the design a second engineer can build from. Do not write the workflow itself, and do not write the design to a file: the whole design goes in the `design` result field, where the user reads it at an ask.

1. Read the idea in the input.
2. Learn what already exists:
   - List the installed workflows and skills: the `workflows/` and `skills/` folders of each catalog. The catalogs are `.penguin/` in the project, `~/.penguin/`, and the starter examples that ship with penguin.
   - Read two or three of those workflow files, for the idiom and the param style.
   - Read the catalog's `penguin-env.d.ts`, beside its `adapters/` folder, for the ctx types, so every step you design is a call an adapter offers.
3. Design the smallest workflow that does the one thing the idea asks. When the idea splits into more, design the first piece and name the rest as separate workflow ideas at the end of the design.
4. Put the whole design in `design`, as markdown:
   - the description, one line
   - the params, few (rules below)
   - the control flow, as a short numbered sketch: sessions, turns, asks, and loops with their bounds
   - the skills: each installed skill to reuse by name, and each new skill with a one-line description
   - the workflows to compose, by file
   - the acceptance checks, eight at most, each one a reviewer can check by reading the file

## Params

The default schema is one required free-text param: the subject the user types after the run name (a ticket, an idea, a path). Most workflows need nothing else. Every further param must pass all three tests:

- The run cannot start without it.
- No agent turn can derive it.
- No ask can collect it at the moment it matters.

A param a person fills carries a one-line `.describe()`, because that line is the only label the launch form shows. A param only a calling workflow fills carries `.meta({ internal: true })` instead, which keeps it out of the form. Design each param as one or the other. A workflow only a calling workflow starts carries `internal: true` beside its description, which keeps it out of the launch list the same way.

The folder a child workflow works in is never a param. `call` takes it as a `cwd` option, so design the child to work where it is run.

What fails a test is a literal in the file, a default, a turn, or an ask. A loop bound is a literal or an optional param with a default. Params check the form of a value, never its meaning: a repo convention (a branch pattern, a folder name, a flag key) is skill craft, not a zod regex.

## The penguin model

- Params are the data the engine needs before code runs. Everything after that is code over ctx, or an ask.
- Design the happy path only. An adapter call that the world refuses throws a fault, and the engine holds the run at a gate: a fixer agent tries, then the person decides retry or stop. Design failure handling only where this workflow wants something different, and say why.
- An adapter's semantic negatives are data, never failures: `dirty: false`, a null pull request, a conflicted rebase. Branch on those; leave faults to the engine.
- Prefer the goal-shaped calls: `vcs.sync` puts a branch on its base and on origin, `github.pr.ensure` finds, reuses, or opens the pull request and answers `landed` when the work already merged. They converge on a moving world so the design does not have to.
- Keep no state the workflow can re-read. The world moves while a run blocks on an ask or a watch, so read it again before acting, and give a long-lived ask a premise (`view.ask(question, shape, { until })`) so a question about a dead world withdraws itself.
- Control flow lives in the workflow. Craft lives in skills. A long inline prompt is a missing skill.
- Compose installed workflows before you design new turns, and reuse installed skills before you name new ones. More than one new skill needs a reason in the design.
- A workflow has no shell. Every side effect is an adapter method on ctx or an agent turn, so every step in the design names the one it uses.
- One session is one conversation. Reuse a session for continuity. Open a fresh one only for fresh eyes: a fresh session reads the world again, and that is the slow part.
- Pass what one turn learned into the next turn's input, so nothing is read twice.
- Bound a loop that retries a step, and scope the bound to that step, so the next step starts it fresh. Ask when it runs out. Work the input sizes is not a runaway: a branch with more conflicting commits is a bigger job, and a budget spent on succeeding is a bug.
- An ask checks the form of an answer, never its meaning. A workflow that wants approval loops on the answer. A workflow that needs two facts asks twice.
- A result is a small typed envelope: verdicts, numbers, short strings, paths, and the text the workflow passes onward. A document only a human opens is a markdown file, referenced by path.
