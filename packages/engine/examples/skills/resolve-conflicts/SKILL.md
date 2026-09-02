---
name: resolve-conflicts
description: Resolves the conflicted files of a rebase that stopped, and stages them. Use when a rebase halts with conflict markers in the tree.
---

# Resolve the rebase conflicts

A rebase stopped, and the input holds what it stopped on: `# HEAD` is the commit it has already landed, `# Replaying` is the commit it is applying now with its patch, and `# Conflicted files` holds each conflicted file as the tree has it, markers and all. Resolve them and stage them. Do not run `git rebase --continue`, and do not run `git rebase --abort`. penguin continues the rebase after you answer.

1. Read the conflicts in the input. Read a file yourself only when its section ends at a `cut here` line, or when the resolution needs code the input does not carry.
2. Keep both intents. The branch changed the code for one reason, and the other side changed it for another. A resolution that drops one of them is a bug.
3. Ask what the merged code must do, then write it. Never keep a marker, and never keep dead halves of both sides.
4. Run the checks the file belongs to, when the repository has them.
5. Stage each file you resolved: `git add <file>`.
6. Set `resolved` to true only when no conflict marker is left and every conflicted file is staged.
7. Put the reasoning in `notes`: what each side wanted, and what you kept. When a conflict is beyond you, say what is left and set `resolved` to false.

You resolve conflicts. You never change what the branch set out to do.
