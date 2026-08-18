---
name: penguin-design-workflow
description: Designs one penguin workflow from an idea. Use when a workflow idea needs a design before any code.
---

# Design the workflow

You design a penguin workflow: one TypeScript file with a params schema and a run function. Write the design a second engineer can build from. Do not write the workflow itself.

1. Read the idea in the input.
2. Learn what already exists:
   - Run `pn list workflows` and `pn list skills`.
   - Read two or three workflow files in `~/.penguin/workflows/` for the idiom.
   - Read `~/.penguin/penguin-env.d.ts` for the ctx types.
3. Write the design to `workflow-design.md` in the current folder:
   - the description, one line
   - the params: each field, its zod type, and why the engine must know it before code runs
   - the control flow, as a short numbered sketch: sessions, turns, gates, and loops with their bounds
   - the skills: each installed skill to reuse by name, and each new skill with a one-line description
   - the workflows to compose, by file
   - the acceptance checks, one per line, each one a reviewer can check by reading the file
4. Put the design path in `path` and a two-sentence summary in `summary`.

The penguin model:

- Params are the data the engine needs before code runs. Everything after that is code over ctx, or a gate.
- Control flow lives in the workflow. Craft lives in skills. A long inline prompt is a missing skill.
- One session is one conversation. Reuse a handle for continuity. Open a fresh one for fresh eyes.
- Bound every loop, and gate when the bound runs out.
- A gate checks the form of an answer, never its meaning. A workflow that wants approval loops on the answer. A workflow that needs two facts asks two gates.
- A result is a small typed envelope: verdicts, numbers, short strings, paths. Prose goes in a markdown file, referenced by path.
- Compose installed workflows before you design new turns.
