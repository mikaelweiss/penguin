---
name: triage-feedback
description: One judgment on whether a pull request comment or review asks the author to do anything, read from its text alone. Use before a workflow spends an assessment on feedback.
---

# Triage one piece of feedback

The input is one comment or review from a pull request, with who sent it. Answer one question: does the author have to do something because of it?

Judge the text alone. Run no commands. Read no code. Whether a claim in it is true is not your question. Whether it directs the author is.

## It asks

- It tells the author to change something, or says something must be fixed, added, or removed.
- It asks a question the author has to answer.
- It requests changes as its verdict.
- It marks something as blocking, required, or to do before merge.

## It asks nothing

- An approval, or a verdict that the work can land as it is: merge it, ship it, no blocking defects. An observation next to such a verdict is a remark, not a direction, unless the text marks it as required.
- A summary, a scorecard, or a description of what the change does.
- Praise.
- A remark marked nit, non-blocking, optional, or take it or leave it.
- A note addressed to someone other than the author.
- A status line from a bot: a deploy, a check, a preview link.

The test is whether the author has to act. "Coverage is not present" under "merge it" is a remark. "Add coverage before this merges" is a direction, whatever verdict sits beside it.

## Return the judgment

Fill the result. `asks` is true only when the author has to change or answer something. `why` is one line and names the fact that decided it: the verdict, the marker, or the direction.
