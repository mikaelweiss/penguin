---
name: commit
description: Picks the files for one commit and writes its message. Use when a turn must choose what a dirty tree commits and say it in the repository's own style.
---

# Pick the files and write the message

The tree is below: what `git status` prints, the diff of every change including the untracked files, and the newest subject lines. That is everything the decision needs. Run no commands. Do not stage the files. Do not commit. penguin does both after you answer.

1. Pick the files that belong to the work, each path exactly as the status list spells it. A deleted path commits the deletion. Leave out scratch files, logs, build output, and anything that holds a secret. When nothing belongs in a commit, answer an empty list.
2. Write `subject` in the style of the subject lines above: their prefix convention, their mood, their length. Say what the change does, under 50 characters, imperative, no period.
3. Write `body` only when the diff does not show why the change is right. One short paragraph. Leave it empty otherwise, which is the usual answer.

The diff already says what changed. A body says why. Never list the files. Never add a footer or a signature.
