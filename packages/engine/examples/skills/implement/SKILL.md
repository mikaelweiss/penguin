---
name: implement
description: Builds the change a plan describes, with its tests and quality gates. Use when a plan is approved and the code must be written.
---

# Implement the plan

Build the change in the plan. The input is the plan itself, and it may also name what the gates said before this change and the blocking findings of the last round.

1. Read the files the plan names before you edit them.
2. Make the change. Match the style of the code around it.
3. Add or update the tests the plan calls for. One test per invariant.
4. Run the repository quality gates: the type check, the linter, and the test suite.
5. Fix what fails. Do not leave a gate red.
6. Commit the work with one message in the repository style.

Stay inside the plan. Raise anything else in the commit body.

## The gates

Take the gate commands from the repository: `package.json` scripts, `AGENTS.md`, `CLAUDE.md`, `Makefile`, the CI workflow. Never guess a command, and never try four spellings of one.

Run each gate once. Send the output to a file, for example `bun test > /tmp/gate-test.log 2>&1`. Read the file. To see the output a second way, read the file again. Never run a gate twice for the same output.

While you fix one failing test, run that test alone. Run the whole suite again only when you believe the fix is done.

A failure the input's baseline already names was there before you started. Leave it. Fix what this change breaks.
