---
name: wa-reproduce
description: Reproduces a reported bug and records the steps that show it. Use before any fix, when a bug report needs confirmation.
---

# Reproduce the bug

Confirm the bug before anyone changes the code. The input is the bug report.

1. Read the report. When the input is an identifier or a URL, use the CLI that owns it, for example `gh issue view <id>`.
2. Read the code the report points at.
3. Run the shortest command that should show the bug. Keep the command and its output.
4. Add a failing test when the repository tests that code.
5. Set `reproduced` to true only when you saw the wrong behavior yourself.
6. Put the steps, the expected result, and the real result in `notes`. Name the file and the line you suspect.
7. When you cannot reproduce it, put what you ran and what you got in `notes`.

Do not fix the bug. Leave the failing test in the working tree.
