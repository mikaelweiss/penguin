# wa: product definition

## Problem

Coding agents follow prose skill files well, but prose is bad at control flow, state, loop bounds, and human gates. Real development work (ticket to merged PR) is full of exactly those: conditionals, retries, review loops, pauses for human input. And an agent cannot enforce limits on itself.

wa splits the two concerns. Structured control flow belongs to an engine. Craft (how to plan, how to review, how to migrate one page) belongs to short prose skills, one per step. The engine runs the workflow. Agents execute steps.

## What wa is

A TypeScript CLI on Node. It runs one workflow as one live process against any repository or folder, with any coding agent CLI. A workflow is a TypeScript file: a params schema plus a run function over `ctx`. Workflows compose: one workflow calls another as a function. Everything outside the run function is an adapter: agents, git, GitHub, the display. The terminal is a viewer: it attaches to a run, watches, sends messages, and detaches. The run keeps going without it, and the full history is files on disk.

## Principles

1. **A run is a live process.** It executes until the run function returns or the user stops it. It waits in memory for input, and `wa ps` shows its state: running, blocked, idle, or done.
2. **The terminal is a viewer.** `wa run` attaches one, `q` detaches, and `wa attach` joins any run with its full history, as if attached from the start. Closing a terminal never touches a run.
3. **The outside world is an adapter.** All IO goes through named adapters with typed interfaces: `ctx.agent`, `ctx.vcs`, `ctx.github`, `ctx.view`. Each is an ordinary TypeScript file the user can read, edit, or replace. Provider CLIs (`claude`, `git`, `gh`) run inside adapters, under the user's existing credentials. A workflow can only do what an adapter offers.
4. **Definitions are files the user keeps anywhere.** Team workflows, skills, and adapters sit in `<project>/.wa/` and ship in git. Personal ones sit in `~/.wa/`. wa lists both and runs either. Run state lives under `~/.wa/`.
5. **Params are data, workflows are code.** What the engine must know before code runs is one schema. Everything inside a run's lifetime is TypeScript over `ctx`, so control flow never grows a schema.
6. **Workflows compose as functions.** A workflow imports another workflow, calls it with params, and receives its return value. Small atomic workflows build large ones, and only the root is a run.
7. **Agent-agnostic.** An agent is an adapter with the `agent` role. The claude adapter ships. An adapter for another CLI is one file with the same role, and any session can name the implementation it wants.
8. **The engine enforces what agents cannot self-enforce.** Gates, schema-valid results, and loop bounds live in workflow code that the engine executes, never in agent hands.
9. **The engine ships empty, the home starts full.** The engine depends on no adapter and no definition. Install copies the starter catalog (`30-defaults.md`) into `~/.wa/`. Every entry is an ordinary file the user can edit or delete.

## Glossary

One name for one thing, used everywhere (code, UI, specs):

- **workflow**: one TypeScript file: a params schema plus a run function. Callable from other workflows.
- **run**: one execution of a root workflow: one process, one name, one history on disk.
- **state**: where a run is: running, blocked (waiting on the user), idle (waiting on the outside world), or done.
- **step**: one ctx call in a run function: an adapter method, an agent turn, a session, or a gate.
- **adapter**: one TypeScript file that gives workflows one typed capability. It declares a role and a name.
- **role**: the `ctx` key an adapter provides: `agent`, `vcs`, `github`, `view`, or one the user invents.
- **session**: one agent conversation. `ctx.agent()` opens it, and every turn on the handle continues it.
- **turn**: one prompt to a session and its result. A workflow awaits it or stops it early.
- **skill**: the markdown craft file an agent turn follows, in the Agent Skills format. A turn names it, and wa finds it in a skills directory.
- **result**: the small JSON envelope an agent turn produces. Schema-validated.
- **gate**: a step that asks a question and waits for the human answer.
- **message**: one line sent into a run from a viewer, addressed to the run or to one named session.
- **agent**: an external coding CLI, driven by an adapter with the `agent` role.
- **event**: one typed object about the run, sent to whatever is watching. The run's `events.jsonl` keeps them all.
- **view**: the run's typed output surface on `ctx`: activities, facts, events, artifacts, watches. A view adapter renders them.
