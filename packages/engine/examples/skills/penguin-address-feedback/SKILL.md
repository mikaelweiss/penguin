---
name: penguin-address-feedback
description: Answers the open review threads on a pull request, with code changes or replies. Use when a pull request has unresolved review comments.
---

# Address the pull request feedback

Answer the open review comments on the pull request for this branch.

1. Read the open threads:
   `gh api graphql -f query='{ repository(owner: "OWNER", name: "REPO") { pullRequest(number: N) { reviewThreads(first: 50) { nodes { isResolved comments(first: 10) { nodes { body path author { login } } } } } } } }'`
2. Group the threads. One code change can answer several.
3. Change the code for each thread you agree with.
4. Reply to each thread you disagree with. Give the reason and the evidence.
5. Run the repository quality gates. Fix what fails.

Do not stage the files. Do not commit. Do not push. penguin does all three after you answer.

Do not resolve a thread you answered with a reply only. The reviewer resolves it.
