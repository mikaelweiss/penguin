---
name: assess-feedback
description: Verifies each piece of pull request feedback against the code and writes what it would change, in plain words, without touching anything. Use before a workflow acts on review feedback.
---

# Assess the pull request feedback

The input names the pull request and says what arrived: a review, comments, or a direction from the user. Work out what is true and what you would do about it. Change nothing.

A person reads your answer and decides. They have not read the threads and they may not know the code. Write for them.

## Step 1 - Collect

Read the owner, the repo, and the number out of the pull request url.

Read the open threads:

    gh api graphql -f query='{ repository(owner: "OWNER", name: "REPO") { pullRequest(number: N) { reviewThreads(first: 50) { nodes { isResolved comments(first: 10) { nodes { body path line author { login } } } } } } } }'

Skip the resolved ones. A thread someone already closed is not yours to reopen.

A direction from the user in the input is an issue too. Treat it the same as a thread from here on.

Group what you collected. One code change often answers several threads, and one issue is one entry in your answer, not one per comment.

## Step 2 - Verify

Never take a claim on trust. For each issue, read the code it names and the code that reaches it: the callers, the functions it calls, the types and config it depends on.

Then answer, from what you read:

- Does the code actually do what the comment says it does?
- Does the failure it names have an input or a state that causes it? Name that input.
- Does the codebase already handle it somewhere the reviewer did not look?

A comment can be right about the problem and wrong about the cause. Say which part holds.

## Step 3 - Decide

Each issue ends one of two ways.

- **change**: the comment holds, or it asks for something worth doing anyway. The code changes.
- **reply**: the comment does not hold, or the change costs more than it is worth. The thread gets an answer, and the code stays.

A reply needs evidence, not an opinion. Name the file and the line that proves it.

## Step 4 - Sketch the change

Write what you would change before anyone approves it. Name every file you would touch, and say what happens in each. If the sketch needs a file you have not read, read it now, then check the issue again. Many issues die here, on code that already covers the case.

## Step 5 - Return the assessment

Fill the result. One entry per issue.

- `title`: the issue in one short line, in plain words. No jargon the reviewer used that the code does not need.
- `where`: the file and the lines it lands on. Empty when it names no code.
- `holds`: true only when the code you read confirms the issue.
- `why`: one or two sentences on what the code actually does. This is the part a person who has not read the thread has to be able to follow.
- `action`: `change` or `reply`.
- `plan`: exactly what you would change, file by file, or exactly what the reply says. Specific enough that a person can agree or disagree with it without reading the code.

An empty list is an answer. Return it when nothing is left open, or when everything the threads raise is already handled.

Do not edit a file. Do not stage, commit, or push. Do not post a comment or resolve a thread. penguin asks the person first.

## Read in batches

Every tool call sends the whole conversation to the model again, so ten small reads cost ten times what one read of the same files costs. When you know the next several files or searches you need, run them in one command. One call per question, not one per file.
