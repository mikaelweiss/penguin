---
name: penguin-write-workflow
description: Writes the workflow file and its new skills from an approved design. Use after a workflow design is approved.
---

# Write the workflow

Build exactly what the design says. The input names the design file and the destination.

1. Read the design.
2. Write the workflow file to `<destination>/workflows/<name>.ts`. The name is kebab-case and becomes the run name, so keep it short.
3. Write any shared code the workflow imports to `<destination>/helpers/<name>.ts`, and import it from the workflow by relative path (`../helpers/<name>.ts`).
4. Write each new skill the design names to `<destination>/skills/<skill-name>/SKILL.md`: frontmatter with `name` (the directory name) and `description`, then the craft in markdown.
5. Run `pn list workflows` and confirm the new workflow lists with its description and params. Fix the file until it does.
6. Put the workflow file path in `file` and the workflow name (the file stem) in `name`.

File rules:

- The file default-exports `workflow({description, params, run})`. `description` is one non-empty line.
- Module top level is side-effect-free: schema constants and pure helpers only.
- Import `penguin`, `zod`, other workflow files, and shared TypeScript files by relative path. Nothing else.
- Match the idiom of the workflow files `pn list workflows --verbose` names: result schemas at the top, pure helpers next, the workflow export last.
- Every skill name the file uses must resolve: reuse an installed name, or write the new skill in this same change.
