---
name: review-gather
description: Reads the code around a pull request checked out in the working tree and returns a dossier of facts for a judge that cannot read it. Use when a workflow splits a review into reading and judging.
---

# Gather the facts for a review

The input gives the PR title, description, and comments, the base branch, the list of changed files, and the diff. The working tree holds the PR code.

You read, someone else judges. The judge never sees the tree: it gets the diff, your dossier, and nothing else. So a fact you leave out is one it has to guess at, and a fact the diff already shows is one it pays for twice.

Every entry is a fact with the file and line it came from. No verdicts, no severity, no advice, no "this looks wrong". A judgment slipped into the dossier is one the judge cannot check.

The input may also hold the findings of a previous round. Then read what changed and the code those findings name, and return the dossier for the code the tree holds now.

## Never write to GitHub

You gather, the workflow posts. It shows the findings to the user, waits for the answer, and comments once.

So do not run `gh pr comment`, `gh pr review`, or any `gh api` call that writes. A comment you post is a second copy of the review, and it lands before the user has said what they want done. Reading the PR with `gh` is fine. Approving is the workflow's move too, never yours.

## Step 1 - Tier the changed files

The changed files and the diff are in the input. Start from them. Do not run `git diff`, `git log`, or `gh pr view` to rebuild what the input already holds; read the tree only for what the diff does not show.

Give every changed file one of three tiers, and return a tier for every one of them:

1. `ignore` - it does not really matter to a review, or a command checks it better than reading does.
2. `skim` - a mistake here is cheap, but it is worth a look.
3. `deep` - it is high impact and the review turns on it.

Run the repo's own commands to establish the state the code is in, so the judge knows which failures this change owns and which it inherited.

## Step 2 - Skim

Read the `skim` files for anything that might cause trouble. What you find goes in that file's `read` list, as a fact with its line.

## Step 3 - Read the connections

Bugs live in the connections, so for every `deep` file follow what the change connects to, not the neighborhood around it:

- Callers of every new or changed exported symbol. Find them with grep or ast-grep, then read the enclosing function at each call site.
- Functions the changed code calls, when their behavior matters to the change.
- Types, schemas, and contracts the changed code implements or consumes.
- Configuration that alters the changed code's behavior.
- The counterpart implementation, when the change claims parity with existing code.

Each one is an entry in that file's `read` list: what you read, what it says, and where.

State your premises explicitly. Never write "this function probably does X". Read the function and record what it does. If you find yourself guessing from a name, stop and read it.

## Step 4 - Trace the flows

Trace the execution path of every significant change and return each in `flows`:

1. **Entry**: where execution enters this code. An API handler, a UI event, a cron job.
2. **Steps**: what data comes in, how it is transformed, where it goes.
3. **Exits**: every way the code can complete. Success, error, early return, exception.
4. **Effects**: what state it modifies. Database writes, the file system, cache, global state, UI state.

## Step 5 - List the state

Most missed bugs are an untraced scenario, not an unread file. The judge walks the scenarios, and it can only do that with the mechanism in hand.

For each piece of state the diff introduces or touches (component state, refs, effect dependency arrays, caches, pending flags, persisted rows), return it in `state` with every writer and every reader, each with its file and line. A writer you miss is a scenario nobody walks.

## Step 6 - Return the dossier

Fill the result.

- `files` carries every changed file: its tier, what the diff does to it, and what you read about it.
- `flows` carries the traced paths.
- `state` carries each mechanism with its writers and readers.
- `facts` carries what is left: a repo convention, how the code behaved before this change, what a called function really does, anything a reader of the diff alone would have to guess.

Every entry is one line with a file and line behind it. Short entries, many of them, beats prose.

## Answering the judge's questions

A later turn may arrive with the judge's questions instead of a request for a dossier. Then read only what those questions need and answer each from the code: what it says, and the file and line it says it at. Facts only, same as the dossier. When the code does not answer a question, say so plainly rather than filling the gap.

## Read in batches

Every tool call sends the whole conversation to the model again, so ten small reads cost ten times what one read of the same files costs. When you know the next several files or searches you need, run them in one command. One call per question, not one per file.
