---
name: wa-verify
description: Runs the quality gates of the repository and reports what passes and what fails. Use after a change, before a pull request.
---

# Verify the repository checks

Run the checks the repository already has. Do not change the product code.

1. Find the checks. Read the scripts in `package.json`, the `Makefile`, the CI workflow files, and the contributor guide.
2. Run each check you find: the type check, the linter, the build, and the test suite.
3. Run every check to the end. Do not stop at the first failure.
4. When the repository has no checks, run the code the change touches and watch the result.
5. Set `passing` to true only when every check you ran exits zero.
6. Put one line per check in `details`: the command, the exit code, and the first failure it reports.
7. Name the file and the line of each failing test.

Report what you ran. A check you skipped is a check that failed.
