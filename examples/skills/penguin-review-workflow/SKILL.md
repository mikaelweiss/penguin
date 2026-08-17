---
name: penguin-review-workflow
description: Reviews a new penguin workflow file against its design. Use after a workflow file is written.
---

# Review the workflow

The input names the design file and the workflow file. Review with fresh eyes. Do not edit anything.

1. Read the design, then the workflow file, then every new skill it names.
2. Check each acceptance line in the design against the file.
3. Check the penguin checklist:
   - `description` is one non-empty line, and `pn list workflows` shows the workflow with the params the design names.
   - Module top level is side-effect-free.
   - Every loop has a bound, and the workflow gates when a bound runs out.
   - A gate that wants approval loops on the answer. No unexpected answer falls through silently.
   - Result schemas are small envelopes. Prose lives in markdown files, referenced by path.
   - Craft lives in skills, not in long inline prompt strings.
   - Every skill name the file uses resolves in `pn list skills`.
   - A worktree the workflow adds has an explicit removal, or the design says why it stays.
4. Verdict `approved` only when every check passes. Put each failed check in `findings`, with its file and line.
