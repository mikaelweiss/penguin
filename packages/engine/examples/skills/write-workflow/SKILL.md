---
name: write-workflow
description: Writes the workflow file and its new skills from an approved design. Use after a workflow design is approved.
---

# Write the workflow

Build exactly what the design says. The input carries the design and names the destination.

1. Read the design in the input.
2. Write the workflow file to `<destination>/workflows/<name>.ts`. The name is kebab-case and becomes the run name, so keep it short.
3. Write any shared code the workflow imports to `<destination>/helpers/<name>.ts`, and import it from the workflow by relative path (`../helpers/<name>.ts`).
4. Write each new skill the design names to `<destination>/skills/<skill-name>/SKILL.md`: frontmatter with `name` (the directory name) and `description`, then the craft in markdown.
5. Read the file once more against the file rules below, and fix what misses.
6. Put the workflow file path in `file` and the workflow name (the file stem) in `name`.

File rules:

- The file default-exports `workflow({description, params, run})`. `description` is one non-empty line.
- Every param a person fills carries a one-line `.describe()`. A param only a calling workflow fills carries `.meta({ internal: true })` instead. A param that is neither refuses to load.
- A child workflow's folder is a `call` option, not a param: `call(ctx, child, params, { cwd })`.
- Module top level is side-effect-free: schema constants and pure helpers only.
- Import `penguin`, `zod`, other workflow files, and shared TypeScript files by relative path. Nothing else.
- Match the idiom of the installed workflow files: result schemas at the top, pure helpers next, the workflow export last.
- Every skill name the file uses must resolve: reuse an installed name, or write the new skill in this same change.
