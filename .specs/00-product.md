# wa: product definition

## Problem

Coding agents follow prose skill files well but prose is bad at control flow, state, loop limits, and human gates. Real development work (ticket to merged PR) is full of exactly those: conditionals, retries, review loops, pauses for human input. Teams also cannot trust an agent to enforce limits on itself.

wa splits the two concerns. Structured control flow belongs to a deterministic engine. Craft (how to plan, how to review, how to migrate one page) belongs to short prose skills, one per step. The engine runs the workflow. Agents execute steps.

## What wa is

A single Go binary: a CLI, no daemon. It runs one workflow as a foreground process against any repository or folder, with any coding agent. A workflow is one TypeScript file: a declarative manifest plus a run function over a small step API, executed durably through journaled replay. A run can park at a gate for days: parked state is files on disk, and one command resumes it.

## Principles

1. **No background machinery.** A run is a foreground process. A parked run is files on disk. Whatever wakes a run is a human or cron typing a wa command. There is no daemon, no socket, and no event system.
2. **Provider IO is a command plus a skill.** wa has no provider integrations. A workflow reads a ticket or posts a comment with `step.command` and the user's own CLIs (`gh`, `linear`), under the user's existing credentials. The engine never knows what GitHub is.
3. **Definitions can live in the repo or globally. State always lives globally.** Team workflows go in `.wa/workflows/` and ship in git. Personal workflows go in `~/.wa/workflows/`. Run state never touches the repo.
4. **Manifests are data, workflows are code.** What the engine needs before code runs (params, limits, defaults) is declarative. Everything inside a run's lifetime is TypeScript over a small primitive API, so control flow never grows a schema. `tsc`, `wa lint`, and `wa sim` give authors (human or AI) the same feedback loop a compiler gives a programmer.
5. **Agent-agnostic by default.** An agent is a config entry: a command template, not code. A workflow with no executor config runs on the configured default. Agent and model are overridable per workflow and per step.
6. **The engine enforces what agents cannot self-enforce.** Loop limits, gates, timeouts, schema-valid results.
7. **The core ships empty.** The engine depends on no agent and no definition. The default agent config, default workflows, and skills are catalog entries in `30-defaults.md`, and every entry is removable.

## Non-goals

- Not a hosted service. wa runs on the developer's machine.
- Not a daemon. Nothing runs when the user is not running it. Event-driven automation is out of scope: OS cron calling `wa` covers schedules.
- Not an agent. wa never calls a model directly. Agents are external CLIs.
- Not a ticket system. Tickets stay in GitHub, Linear, or Jira. Workflows read and write them through the provider's own CLI.

## Glossary

One name for one thing, used everywhere (code, UI, specs):

- **workflow**: one TypeScript file: a manifest plus a run function.
- **manifest**: the declarative header: params, limits, defaults.
- **run**: one execution of a workflow, with its own name and journal.
- **step**: one awaited primitive call in a run function.
- **journal**: the append-only record of every primitive call and result. Replay reads it.
- **skill**: the markdown craft file an agent step follows. Contains no control flow.
- **result**: the small JSON envelope an agent step must produce. Schema-validated.
- **artifact**: a document an agent step writes as a file (markdown), referenced from the result.
- **output**: the value a run function returns.
- **gate**: a step that asks a question and waits for the human answer.
- **parked**: a run stopped at an unanswered gate or an interruption, waiting on disk for resume.
- **agent**: an external coding CLI that executes agent steps, defined by a config entry.
- **executor**: the agent + model that runs one agent step.
