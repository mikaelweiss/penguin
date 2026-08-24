---
name: baseline
description: Records what the quality gates say before a change touches the tree. Use before any implementation, on a fresh worktree, so later reviews know which failures were already there.
---

# Read the baseline

Say what the gates report on this tree right now. Change nothing: no edit, no commit, no new file.

1. Find the gate commands. Read the repository's own instructions first: `package.json` scripts, `AGENTS.md`, `CLAUDE.md`, `Makefile`, the CI workflow. Take the commands they name. Never guess a command, and never try four spellings of one.
2. Run each gate once. Send the output to a file, for example `bun test > /tmp/gate-test.log 2>&1`. Read the file. To see the output a second way, read the file again. Never run a gate twice for the same output.
3. Write one line per gate: the command, the verdict, and the name of each check that fails. Name the failing test, not the count alone. A later reader has to match a failure to this line by name.
4. Set `green` to true only when every gate passed.

Report only what the commands printed. Do not fix a failure, and do not explain one.
