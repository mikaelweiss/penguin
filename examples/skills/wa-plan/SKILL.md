---
name: wa-plan
description: Writes the plan and the acceptance checks for one change. Use when a ticket is ready to build and needs a plan before any code.
---

# Plan the change

Write the plan a second engineer can build from. Do not write code.

1. Read the ticket named in the input.
2. Read every file the change touches. Read the tests next to them.
3. Write the plan to `plan.md` in the current folder:
   - the change, in one paragraph
   - the files to touch, each with the edit in one line
   - the invariant for each piece of shared or persisted state
   - what stays out of scope
4. Write the acceptance checks to `acceptance.md` in the current folder. Each check is one line. A reviewer can run or read each check.
5. Put the path of each file in the result: `spec` is the plan path, `acceptance` is the checks path.

Keep both files short. A plan that lists every line of the diff is too long.
