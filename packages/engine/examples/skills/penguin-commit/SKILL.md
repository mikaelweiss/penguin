---
name: penguin-commit
description: Picks the files that belong in the commit and writes its message, in the style of the repository. Use before a commit, when the work in the tree has to become one commit.
---

# Pick the files and write the message

Choose what this commit holds and write its message. Do not stage the files. Do not commit. penguin does both after you answer.

1. Read the tree: `git status --porcelain`, then `git diff` for the tracked changes.
2. Read every untracked file before you decide on it. `git diff` does not show it, and listing it still commits it.
3. Pick the files that belong to the work, each path exactly as `git status --porcelain` prints it. A deleted path commits the deletion. Leave out scratch files, logs, build output, and anything that holds a secret. When nothing belongs in a commit, answer an empty list.
4. Read the last twenty subject lines: `git log --oneline -20`. They are the style to match.
5. Write the title. Match the repository style: its prefix convention, its mood, and its length. Say what the change does, under 50 characters, imperative, no period.
6. Write a body only when the diff does not show why the change is right. One short paragraph.
7. Put the paths in `files` and the whole message in `message`, the title on the first line, a blank line before a body.

The diff already says what changed. A body says why. Never list the files. Never add a footer or a signature.
