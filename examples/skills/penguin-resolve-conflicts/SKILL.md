---
name: penguin-resolve-conflicts
description: Resolves the conflicted files of a rebase that stopped, and stages them. Use when a rebase halts with conflict markers in the tree.
---

# Resolve the rebase conflicts

A rebase stopped on the files in the input. Resolve them and stage them. Do not run `git rebase --continue`, and do not run `git rebase --abort`. penguin continues the rebase after you answer.

1. Read the commit being replayed: `git log -1 HEAD`, then `git rebase --show-current-patch`.
2. Read each conflicted file at its markers. Read the code around them too.
3. Keep both intents. The branch changed the code for one reason, and the other side changed it for another. A resolution that drops one of them is a bug.
4. Ask what the merged code must do, then write it. Never keep a marker, and never keep dead halves of both sides.
5. Run the checks the file belongs to, when the repository has them.
6. Stage each file you resolved: `git add <file>`.
7. Set `resolved` to true only when no conflict marker is left and every conflicted file is staged.
8. Put the reasoning in `notes`: what each side wanted, and what you kept. When a conflict is beyond you, say what is left and set `resolved` to false.

You resolve conflicts. You never change what the branch set out to do.
