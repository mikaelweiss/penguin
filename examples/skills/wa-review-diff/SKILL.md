---
name: wa-review-diff
description: Reviews a pull request diff and writes the findings to a markdown file. Use when an open pull request needs a review comment, before the merge.
---

# Review the diff

Review the diff in the input. Review the change, not the whole repository.

1. Read the whole diff before you judge one hunk.
2. Read the files around each hunk in the repository. A diff hides its context.
3. Check each error path, each invariant, each pair of writers, and each secret.
4. Check that the tests in the diff cover the behavior the diff changes.
5. Write the findings to `findings.md` in the current folder. One heading per file, one bullet per defect: the line, the failure, and the fix.
6. Write each bullet so the author can act on it. Leave out the style opinions.
7. Set `verdict` to `approved` when you found no defect, and to `changes_needed` when you found one.
8. Put the path of the findings file in `report`.

The file becomes a comment on the pull request. Write it for the author.
