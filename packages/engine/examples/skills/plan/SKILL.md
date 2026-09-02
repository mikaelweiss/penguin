---
name: plan
description: Writes the plan and the acceptance checks for one change. Use when a ticket is ready to build and needs a plan before any code.
---

# Plan: discover deterministically, decide, commit

Plans fail in two ways: missing gates the repo documents somewhere, and missing failure modes nobody wrote down anywhere.

Explore inline with Grep, Glob, and Read. Do not spawn subagents.

## 1. Scope

Name the surfaces the task will touch: the apps/libs, the concrete files where known, the API boundaries crossed, and any state that persists beyond one request (database rows, stored blobs, caches, localStorage, feature flags).

## 2. Deterministic discovery (lookup, not wandering)

The goal is the documents that govern this change, found by lookup rather than archaeology. In order:

1. Read every rule file that governs the touched paths in full: path-scoped CLAUDE.md files, lint configs, contributing docs.
2. If the repo has an instruction map or the root CLAUDE.md links binding standards docs for the touched surfaces, read the ones that apply.
3. Read the entry-point files that will change and their immediate callers.
4. Live-verify boundary facts instead of assuming them: what an endpoint actually returns (read the server code or call it), what a resource actually emits, what an existing helper actually does.

Timebox this. When the matched docs and entry points are read, discovery is done; do not re-derive what the docs already state.

You may have triaged this ticket earlier in this conversation, or the input may carry a section of what triage already read. Either way those facts are yours: start from them, and read a file again only to answer a question they leave open.

When you planned an earlier task of the same ticket in this conversation, this task is the next slice. Build on that plan and do not repeat what it already covers.

## 3. Definition of done

From the matched rules and docs, enumerate every gate that applies to the touched surfaces: lint, required test surfaces, contract/consumer-provider chains, QA or walkthrough docs, feature-flag lockstep files, manual checklists. Each becomes an acceptance criterion in the plan. Deliberately skipping a documented gate is a scope decision: write it as an explicit out-of-scope line for the user to see, never omit it silently.

## 4. Failure-mode pass

For every piece of persisted state, shared resource, or concurrent actor in the design, ask:

- What happens when the data is older than this code, newer than this code, partially corrupt, or absent?
- What happens when two actors (tabs, devices, users, requests) write at once?
- What happens when permissions, tenant, or selection context shift underneath a live view?
- What happens when the flow is interrupted halfway?

Write the chosen invariant for each as one sentence in the plan (for example: "a client that reads a document version it does not understand renders nothing and never writes"). Skipping a question because it genuinely cannot occur is fine; say so in a clause, not by silence.

## 5. Decisions

A genuine product or scope choice the repository cannot settle goes back to the user: return `blocked` with the questions and no plan. The answers arrive in the next turn. Ask only what discovery could not answer. Never bury a decision inside the plan as an assumption, and never present a plan with an open question. The plan is a roadmap the implementer executes without research, exploration, or question answering.

## 6. The artifact

- **Goal**: one sentence, what changes for a user or caller.
- **Acceptance criteria**: numbered, provable by a command, test, or manual step; includes every gate from step 3.
- **Invariants**: the one-sentence outcomes of step 4.
- **Out of scope**: including any deliberately skipped gate.
- **Verification**: the exact commands and checklist references.

Keep it lean: decisions and invariants, not prose. Each invariant should be implementable in a few lines and pinned by a test. Prefer one decision plus one test over defensive sprawl.

Return the whole plan as `plan`, in markdown, and the acceptance criteria as `acceptance`, one per line.

## Read in batches

Every tool call sends the whole conversation to the model again, so ten small reads cost ten times what one read of the same files costs. When you know the next several files or searches you need, run them in one command. One call per question, not one per file.
