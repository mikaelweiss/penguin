---
name: penguin-branch
description: Names the git branch that will hold the work for a ticket, in the style of the repository. Use before a worktree is cut for a new change.
---

# Name the branch

Name the branch for the work the input describes. The input holds the ticket and what triage read.

1. Read the branch names this repository uses: `git branch -a --sort=-committerdate --format='%(refname:short)' | head -20`. They are the style to match.
2. Match that style: how the names are built, and how much they say.
3. Say what the work does, not what the ticket is called. Three to five words.
4. Use lowercase letters, digits, and dashes only. Keep the name under 50 characters.
5. Put the name in `branch`.

Do not create the branch. Do not create a worktree. penguin does both after you answer.
