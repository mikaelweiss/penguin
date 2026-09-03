---
name: plan
description: Writes the plan and the acceptance checks for one change. Use when a ticket is ready to build and needs a plan before any code.
---

# Plan one change

A plan removes choices, not reading. The implementer is an agent with the code in front of it. What it cannot get from the code is the decisions: where the ticket and the code leave more than one reasonable way and the choice matters. The plan settles those, names the gates the change must pass, and says what must be true when it is done.

Two people read it: the person who approves it, and the implementer, who gets the plan and nothing else. Whatever the build needs from the ticket goes in the plan.

Explore inline with Grep, Glob, and Read. Do not spawn subagents.

## The input

The ticket, whole, with its comments. When the ticket builds in several tasks, the split follows it with your task marked. The tasks before yours are in the worktree already: read what they built in the code, not in their text. A scout may have listed the files for this task. Open those before you search, since that search is already paid for. A file the scout could not find is unsearched, not absent.

## The fence

When there is a split, your task is what its line says. Build what its acceptance needs. Shape it so the tasks after yours are not blocked, and build none of their behavior. Anything the ticket wants that no task owns is not yours to build: send it back as a `resplit`.

## 1. Read

Name the surfaces the change touches: the apps or libs, the files where known, the boundaries crossed, and any state that outlives one request (rows, blobs, caches, localStorage, flags). Then, by lookup and not by wandering:

1. Read every rule file that governs the touched paths: path-scoped CLAUDE.md files, lint configs, contributing docs, and the standards docs the root CLAUDE.md links for those surfaces.
2. Read the files that will change and their immediate callers.
3. Verify boundary facts instead of assuming them: what the endpoint returns, what the helper does.

Stop when the matched docs and entry points are read.

## 2. What to return

Exactly one of four things. Settle a resplit before a decision, and a decision before the plan.

`resplit`, when the code shows the remaining split is wrong: your task is really several shippable slices, two remaining tasks are one change, or the ticket wants something no task owns. Give the tasks that remain, yours first, each a scope line as triage writes them. The person approves the split, then you plan the first task.

`decide`, when the ticket and the code do not settle a choice and the outcome matters: hard to reverse, cross-cutting, visible to users, or a new dependency. Give two or three options, what each costs and buys, and the one you would take. The person picks, then you plan.

`blocked`, for a fact only the requester has. Ask only what reading could not answer.

`result`, the plan. A choice that does not matter much (local, reversible, fine either way) is yours: make it and write it under Decisions, where the approval gate is the place to override it.

## 3. Gates

From the rules you read, list the gates that touch the paths in scope: lint, required tests, contract chains, QA or walkthrough docs, flag lockstep files, manual checklists. Each is an acceptance criterion. A gate you skip on purpose is one out-of-scope line, never silence.

## 4. Failure modes

For each piece of persisted state, shared resource, or concurrent actor: what happens when the data is older or newer than the code, corrupt, or absent; when two actors write at once; when permissions or selection shift under a live view; when the flow stops halfway. Each answer is a one-sentence invariant, pinned by one test. When none of it applies, say so in one line and move on.

## 5. The plan

- **Goal**: one sentence, what changes for a user or caller.
- **Bearings**: the files to change, and the one place already doing this well enough to copy.
- **Decisions**: each choice you made, in a line.
- **Acceptance criteria**: numbered, each provable by a command, a test, or a manual step. Every gate from step 3.
- **Invariants**: from step 4, or the one line saying none apply.
- **Out of scope**: what the ticket or the split leaves to others, and any gate you skipped.
- **Verification**: the exact commands.

A line earns its place only if the implementer would plausibly do something different and wrong without it. Say what must be true, not how to write it. A line that could be pasted into a file is implementation: cut it. Paths are bearings, not proof: do not cite to argue.

Return the plan as `plan`, in markdown, and the acceptance criteria as `acceptance`, one per line.
