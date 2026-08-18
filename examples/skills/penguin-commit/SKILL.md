---
name: penguin-commit
description: Writes the commit message for the work in the tree, in the style of the repository. Use before a commit, when the message has to describe work that is already written.
---

# Write the commit message

Write one commit message for the work in this tree. Do not stage the files. Do not commit. penguin does both after you answer.

1. Read the work: `git status --porcelain`, then `git diff` and `git diff --cached`.
2. Read the last twenty subject lines: `git log --oneline -20`. They are the style to match.
3. Write the title. Match the repository style: its prefix convention, its mood, and its length.
4. Write a body only when the diff does not show why the change is right. One short paragraph.
5. Put the whole message in `message`, the title on the first line, a blank line before a body.

The diff already says what changed. A body says why. Never list the files.
