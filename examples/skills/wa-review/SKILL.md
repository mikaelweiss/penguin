---
name: wa-review
description: Reviews a working tree against its acceptance checks and reports each defect. Use after an implementation step, before the pull request.
---

# Review the change

Review the working tree against the acceptance checks. The input is the checks file path.

1. Read the checks.
2. Read the diff: `git diff main...HEAD`.
3. Run the quality gates yourself. Do not trust the report of the last step.
4. Test each check against the diff. A check you cannot confirm is a failed check.
5. Look for the defects tests miss. Check each invariant, each error path, each pair of writers, and each secret.
6. Set `verdict` to `approved` only if every check passes and you found no defect.
7. Put each defect in `findings` as one line: the file, the line, and the failure.

Report what you confirmed. Do not report style opinions.
