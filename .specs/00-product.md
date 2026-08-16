# wa: product definition

## Problem

Coding agents follow prose skill files well but prose is bad at control flow, state, loop limits, and human gates. Real development work (ticket to merged PR) is full of exactly those: conditionals, retries, review loops, pauses for human input. Teams also cannot trust an agent to enforce limits on itself.

wa splits the two concerns. Structured control flow belongs to a deterministic engine. Craft (how to plan, how to review, how to migrate one page) belongs to short prose skills, one per step. The engine runs the workflow. Agents execute steps.

## What wa is

A single Go binary: a CLI plus a local daemon. It runs workflows against any repository or folder, with any coding agent, over long periods, driven by events. A workflow is one TypeScript file: a declarative manifest plus a run function over a small step API, executed durably through journaled replay.

## Principles

1. **Everything inbound is a message.** A Slack reply, a PR comment, a ticket change, a webhook, a timer, text typed in the CLI: all land in a run's mailbox as `{source, type, payload}`. Steps consume messages through filters. A human gate is an outbound message plus a wait for a matching inbound one.
2. **Everything provider-specific is an adapter.** Agent CLIs, event sources, outbound channels, and VCS sit behind small interfaces. The engine core never knows what GitHub is. An adapter ships its own TypeScript types, and a workflow names the adapters it uses: typed requests out, typed objects back, no raw provider data in workflow code.
3. **Definitions can live in the repo or globally. State always lives globally.** Team workflows go in `.wa/workflows/` and ship in git. Personal workflows go in `~/.wa/workflows/`. Run state never touches the repo.
4. **Manifests are data, workflows are code.** What the scheduler needs before code runs (triggers, dedup, pools, limits) is declarative. Everything inside a run's lifetime is TypeScript over a small primitive API, so control flow never grows a schema. `tsc`, `wa lint`, and `wa sim` give authors (human or AI) the same feedback loop a compiler gives a programmer.
5. **Agent-agnostic by default.** A workflow with no executor config runs on whatever agent invokes it or on the configured default. Agent and model are overridable per workflow and per step.
6. **The engine enforces what agents cannot self-enforce.** Loop limits, gates, timeouts, call depth, schema-valid results.
7. **The core ships empty.** The engine depends on no adapter, no workflow, and no skill. Pre-built adapters and default workflows are catalog entries in `30-defaults.md`, and every entry is removable.

## Non-goals

- Not a hosted service. wa runs on the developer's machine.
- Not an agent. wa never calls a model directly. Agents are external CLIs. Even the run namer goes through an agent adapter's cheap tier.
- Not a ticket system. Tickets stay in GitHub, Linear, or Jira. wa reads and writes them through adapters.

## Glossary

One name for one thing, used everywhere (code, UI, specs):

- **workflow**: one TypeScript file: a manifest plus a run function.
- **manifest**: the declarative header: params, triggers, dedup, pool, limits, defaults.
- **run**: one execution of a workflow, with its own name, journal, and mailbox.
- **step**: one awaited primitive call in a run function.
- **journal**: the append-only record of every primitive call and result. Replay reads it.
- **skill**: the markdown craft file an agent step follows. Contains no control flow.
- **message**: one inbound fact delivered to a run: `{source, type, payload}`.
- **mailbox**: the ordered queue of messages for one run.
- **result**: the small JSON envelope an agent step must produce. Schema-validated.
- **artifact**: a document an agent step writes as a file (markdown), referenced from the result.
- **output**: the value a run function returns to its caller.
- **gate**: a step that sends a question and waits for a human reply.
- **trigger**: what creates or wakes a run: manual, schedule, or event.
- **watcher**: the run that holds a workflow's trigger subscriptions and spawns one body run per matching event.
- **subscription**: one typed request to an event source adapter, held by a watcher or a parked `receive`.
- **adapter**: one provider integration: agent, event source, channel, or VCS.
- **executor**: the agent + model + mode that runs one agent step.
