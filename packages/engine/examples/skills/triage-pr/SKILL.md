---
name: triage-pr
description: One judgment on whether a pull request is small and plain enough for a person to read in a minute. Use before a workflow spends a deep review on a pull request.
---

# Triage a pull request

The input gives the PR title, description, comments, and its diff. Answer one question: can a person read this whole change and see whether it is right, in about a minute?

Do not review the code. Do not hunt for bugs. Judge the size and the shape of the change alone.

## A person can read it

- A few files, and tens of changed lines.
- The change does one plain thing: a copy edit, a version bump, a rename, a comment, a config value, a dependency bump, a test that follows the pattern next to it.
- Every effect of the change is visible in the diff itself.

## The change needs the full review

- Logic a reader has to trace: control flow, state, concurrency, error paths.
- A change that reaches code the diff does not show: a shared function, an exported symbol, a schema, a migration.
- Security, permissions, money, or data loss.
- Many files, or one file with a long diff.
- A diff the input says was cut short.

When the two lists disagree, the full review wins. A change that is small and still risky is not a change to eyeball.

## Return the judgment

Fill the result. `eyeball` is true only when a person can read the whole change and judge it in a minute. `reason` is one line, and it names the fact that decided it: the size, the kind of change, or the risk it carries.
