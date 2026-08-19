---
name: penguin-design-workflow
description: Designs one penguin workflow from an idea. Use when a workflow idea needs a design before any code.
---

# Design the workflow

You design a penguin workflow: one TypeScript file with a params schema and a run function. Write the design a second engineer can build from. Do not write the workflow itself, and do not write the design to a file: the whole design goes in the `design` result field, where the user reads it at a gate.

1. Read the idea in the input.
2. Learn what already exists:
   - Run `pn list workflows --verbose` and `pn list skills`.
   - Read two or three of the workflow files the verbose listing names, for the idiom and the param style.
   - Read `~/.penguin/penguin-env.d.ts` for the ctx types, so every step you design is a call an adapter offers.
3. Design the smallest workflow that does the one thing the idea asks. When the idea splits into more, design the first piece and name the rest as separate workflow ideas at the end of the design.
4. Put the whole design in `design`, as markdown:
   - the description, one line
   - the params, few (rules below)
   - the control flow, as a short numbered sketch: sessions, turns, gates, and loops with their bounds
   - the skills: each installed skill to reuse by name, and each new skill with a one-line description
   - the workflows to compose, by file
   - the acceptance checks, eight at most, each one a reviewer can check by reading the file

## Params

The default schema is one required free-text param: the subject the user types after the run name (a ticket, an idea, a path). Most workflows need nothing else. Every further param must pass all three tests:

- The run cannot start without it.
- No agent turn can derive it.
- No gate can ask for it at the moment it matters.

What fails a test is a literal in the file, a default, a turn, or a gate. A loop bound is a literal or an optional param with a default. Params check the form of a value, never its meaning: a repo convention (a branch pattern, a folder name, a flag key) is skill craft, not a zod regex.

## The penguin model

- Params are the data the engine needs before code runs. Everything after that is code over ctx, or a gate.
- Control flow lives in the workflow. Craft lives in skills. A long inline prompt is a missing skill.
- Compose installed workflows before you design new turns, and reuse installed skills before you name new ones. More than one new skill needs a reason in the design.
- A workflow has no shell. Every side effect is an adapter method on ctx or an agent turn, so every step in the design names the one it uses.
- One session is one conversation. Reuse a handle for continuity. Open a fresh one only for fresh eyes: a fresh session reads the world again, and that is the slow part.
- Pass what one turn learned into the next turn's input, so nothing is read twice.
- Bound every loop, and gate when the bound runs out.
- A gate checks the form of an answer, never its meaning. A workflow that wants approval loops on the answer. A workflow that needs two facts asks two gates.
- A result is a small typed envelope: verdicts, numbers, short strings, paths, and the text the workflow passes onward. A document only a human opens is a markdown file, referenced by path.
