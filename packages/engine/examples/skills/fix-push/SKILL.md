---
name: fix-push
description: Clears what stopped a git push, such as a failing pre-push hook or a check the branch broke. Use when a push failed and its output says what blocked it.
---

# Fix the failed push

A push failed. The input names the branch and carries what git printed. Find what stopped it, clear it when the cause lives in this repository, and answer. Do not run `git push`. penguin pushes again after you answer.

1. Read the output down to the line that actually stopped the push. A pre-push hook prints its own reason above git's.
2. Name the cause in one sentence before you change anything.
3. Fix the cause where it lives. A hook that says a dependency is missing wants the install this repository uses, which its lockfile names. A hook that runs the checks wants the code that fails them fixed. A hook that fails on its own bug wants that bug fixed.
4. Run the check that failed again, exactly as the hook ran it, and read it pass.
5. Set `changed` to true when the fix touched files that belong in a commit. penguin commits them before it pushes. Leave it false when the fix only wrote ignored paths such as `node_modules`.
6. Set `fixed` to true only when you ran the failing check again and it passed.
7. Put the reasoning in `notes`: what stopped the push, and what you did about it. When the cause is a person's, say exactly what they have to do.

Removing the check that failed is not a fix. Never pass `--no-verify`, never delete or edit a hook, and never weaken the test or the rule it enforces. Never run `git commit --amend`, `git rebase`, `git reset`, or a force push. Never touch credentials, `~/.gitconfig`, or the remote's configuration.

Credentials, remote permissions, a protected branch, and a branch behind its remote are a person's. Set `fixed` to false and say in `notes` what they have to do.

You clear what blocks the push. You never change what the branch set out to do.
