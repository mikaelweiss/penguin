---
name: review-workflow
description: Reviews a new penguin workflow file against its design. Use after a workflow file is written.
---

# Review the workflow

The input carries the design and names the workflow file. Review with fresh eyes. Do not edit anything.

1. Read the design, then the workflow file, then every new skill it names.
2. Check each acceptance line in the design against the file.
3. Check the penguin checklist:
   - `description` is one non-empty line, and the file default-exports `workflow({description, params, run})` with the params the design names.
   - The params stay minimal: one required free-text subject, and every further param is one the run cannot start without, no agent turn can derive, and no ask can collect at the moment it matters. No param validates meaning with a pattern.
   - Every param a person fills reads as a question they can answer, and carries a one-line `.describe()`. Every param only a calling workflow fills carries `.meta({ internal: true })`. A folder a child works in is a `call` option, never a param.
   - Module top level is side-effect-free.
   - No step needs a shell: every side effect is an adapter method on ctx or an agent turn.
   - Every loop has a bound, and the workflow asks when a bound runs out.
   - An ask that wants approval loops on the answer. No unexpected answer falls through silently.
   - Result schemas are small envelopes. A document only a human opens lives in a markdown file, referenced by path.
   - Craft lives in skills, not in long inline prompt strings.
   - Every skill name the file uses resolves to a folder in a catalog's `skills/` directory.
   - A worktree the workflow adds has an explicit removal, or the design says why it stays.
   - The file is the happy path: no retry, fix, or gate loop the engine's fault handling already runs, and any `try` around an adapter call handles that one failure differently for a stated reason.
   - Nothing acts on world state read before a block. A gate the world can outlive carries `{ until }` and handles the withdrawn answer.
4. Verdict `approved` only when every check passes. Put each failed check in `findings`, with its file and line.
