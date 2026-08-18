---
name: penguin-review
description: Reviews a working tree against its acceptance checks and reports each defect. Use after an implementation step, before the pull request.
---

# Review the change

Review the working tree against the acceptance checks. The input holds the checks, and it may also name the base commit, what the gates said before this change, and the blocking findings of the last round.

1. Read the checks. A task in the input is the checks.
2. Read the diff against the base commit the input names: `git diff <base>..HEAD`. With no base named, use `git diff main...HEAD`. Never diff against a branch that moves while you read it.
3. Run the quality gates yourself. Do not trust the report of the last step.
4. Test each check against the diff. A check you cannot confirm is a failed check.
5. Look for the defects tests miss. Check each invariant, each error path, each pair of writers, and each secret.
6. Split what you found. A defect this change introduced goes in `blocking`, one line each: the file, the line, and the failure. Everything else goes in `notes`: a risk, a smaller cleanup, a thing the next reader should know.
7. Set `verdict` to `changes_needed` when `blocking` holds anything, and to `approved` when it is empty. A note never blocks a change.

## The gates

Take the gate commands from the repository: `package.json` scripts, `AGENTS.md`, `CLAUDE.md`, `Makefile`, the CI workflow. Never guess a command.

Run each gate once. Send the output to a file, for example `bun test > /tmp/review-test.log 2>&1`. Read the file. To see the output a second way, read the file again. Never run a gate twice for the same output.

## The baseline

The input names what each gate said before this change. Trust it.

A failure that line already names is not this change's defect. It is not a blocking finding, it does not fail a check, and it never holds up the verdict. Say in `notes` that it was already there. Do not build a worktree on the base to prove it again, and do not check the base out over this tree.

A gate that is red in a way the baseline does not name is this change's defect. That one blocks.

Report what you confirmed. Do not report style opinions.
