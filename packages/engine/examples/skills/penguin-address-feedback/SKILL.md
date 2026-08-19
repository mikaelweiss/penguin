---
name: penguin-address-feedback
description: Does what the input asks on the pull request it names, with code changes or replies. Use when a pull request has feedback to answer, from its review threads or from the user directly.
---

# Address the pull request feedback

The input names the pull request and says what to do. A direction from the user is the work: make the change it asks for. "Answer the open review threads" means:

1. Read the owner, the repo, and the number out of the pull request url.
2. Read the open threads:
   `gh api graphql -f query='{ repository(owner: "OWNER", name: "REPO") { pullRequest(number: N) { reviewThreads(first: 50) { nodes { isResolved comments(first: 10) { nodes { body path author { login } } } } } } } }'`
3. Group the threads. One code change can answer several.
4. Change the code for each thread you agree with.
5. Reply to each thread you disagree with. Give the reason and the evidence.

Either way, run the repository quality gates. Fix what fails.

Do not stage the files. Do not commit. Do not push. penguin does all three after you answer.

Do not resolve a thread you answered with a reply only. The reviewer resolves it.
