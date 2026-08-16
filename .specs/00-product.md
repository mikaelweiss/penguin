# wa: product definition

## Problem

Coding agents follow prose skill files well, but prose is bad at control flow, state, loop bounds, and human gates. Real development work (ticket to merged PR) is full of exactly those: conditionals, retries, review loops, pauses for human input. And an agent cannot enforce limits on itself.

wa splits the two concerns. Structured control flow belongs to a deterministic engine. Craft (how to plan, how to review, how to migrate one page) belongs to short prose skills, one per step. The engine runs the workflow. Agents execute steps.

## What wa is

A TypeScript CLI on Node. It runs one workflow as a foreground process against any repository or folder, with any coding agent CLI. A workflow is one self-contained TypeScript file: a params schema plus a run function over a small step API, executed durably through journaled replay. A run can park at a gate for days: parked state is files on disk, and one command resumes it.

## Principles

1. **A run is a foreground process.** A parked run is files on disk. A human or cron wakes it with a wa command.
2. **Provider IO is a command plus a skill.** A workflow reads a ticket, posts a comment, or adds a worktree with `step.command` and the user's own CLIs (`gh`, `linear`, `git`), under the user's existing credentials.
3. **Definitions are files the user keeps anywhere.** Team workflows and skills sit in `<project>/.wa/` and ship in git. Personal ones sit in `~/.wa/`. wa lists both and runs either. Run state lives under `~/.wa/`.
4. **Params are data, workflows are code.** What the engine must know before code runs is one schema. Everything inside a run's lifetime is TypeScript over a small primitive API, so control flow never grows a schema.
5. **Agent-agnostic.** An agent is one shell command string. Any step can name its own.
6. **The engine enforces what agents cannot self-enforce.** Gates, schema-valid results, and loop bounds live in workflow code that the engine executes, never in agent hands.
7. **The engine ships empty, the home starts full.** The engine depends on no agent and no definition. Install copies the starter catalog (`30-defaults.md`) into `~/.wa/`. Every entry is an ordinary file the user can edit or delete.

## Glossary

One name for one thing, used everywhere (code, UI, specs):

- **workflow**: one self-contained TypeScript file: a params schema plus a run function.
- **run**: one execution of a workflow, with its own name and journal.
- **step**: one awaited primitive call in a run function.
- **journal**: the append-only record of every primitive call and result. Replay reads it.
- **skill**: the markdown craft file an agent step follows, in the Agent Skills format. A step names it, and wa finds it in a skills directory.
- **result**: the small JSON envelope an agent step produces. Schema-validated.
- **gate**: a step that asks a question and waits for the human answer.
- **parked**: a run waiting on disk, at a gate or after an interruption, for resume.
- **agent**: an external coding CLI, named by one shell command string.
