---
name: address-feedback
description: Carries out an approved plan on a pull request, with code changes and thread replies. Use when a plan for the pull request feedback is already agreed and only the work is left.
---

# Carry out the approved plan

The input names the pull request and carries the plan a person approved. Do that plan. The judgment is already made, so do not remake it.

1. Read the owner, the repo, and the number out of the pull request url.
2. Do the entries marked **Change**. Make the change the plan names, in the files it names.
3. Post the entries marked **Reply**. Find the thread each one belongs to, then reply to it with what the plan says:

       gh api graphql -f query='{ repository(owner: "OWNER", name: "REPO") { pullRequest(number: N) { reviewThreads(first: 50) { nodes { id isResolved comments(first: 10) { nodes { body path author { login } } } } } } } }'

       gh api graphql -f query='mutation($thread:ID!,$body:String!){ addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){ comment { id } } }' -f thread=THREAD_ID -f body='the reply'

4. Run the repository quality gates. Fix what fails.

A later message may ask for something the plan did not cover. That message is the plan now: do what it says.

The plan is the whole scope. Something you would rather do differently, or an issue you meet on the way, goes in your answer as a sentence, not into the code.

Do not stage the files. Do not commit. Do not push. penguin does all three after you answer, and a person sees the commit before it goes up.

Do not resolve a thread you answered with a reply only. The reviewer resolves it.
