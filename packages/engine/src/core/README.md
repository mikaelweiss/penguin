# core

This folder is the definition of penguin. Three primitives, one file each:

| Primitive | File          | One line                                                        |
| --------- | ------------- | --------------------------------------------------------------- |
| Workflow  | `workflow.ts` | Code that runs: params in, steps through adapters, result out.  |
| Adapter   | `adapter.ts`  | A workflow's connection to the outside world.                   |
| Message   | `message.ts`  | The outside world's connection to a running workflow.           |

Everything else in the engine serves these three. Nothing here executes anything: this folder is types, two factory functions, and this document.

## Workflow

A workflow is a plain object with three fields:

```ts
import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "what this does, one line",
  params: z.object({ ticket: z.string() }),

  async run(ctx) {
    // the work
    return { done: true };
  },
});
```

- `description` names the workflow to people and to viewers.
- `params` is a Zod object. The engine validates params before `run` is called, so inside `run` they are already the right shape.
- `run(ctx)` is the work. Whatever it returns is the run's result.

`ctx` is everything a workflow can touch:

- `ctx.params`: the validated params.
- `ctx.gate(question)`: stop and wait for a person. The run shows blocked with the question until a viewer answers. Pass a Zod shape as the second argument to get a typed answer back.
- `ctx.messages.next()`: wait for the next message from outside.
- `ctx.view`: show progress. `activity` groups work under a label, `fact` records a key-value, `event` logs a line, `artifact` points at something produced.
- `ctx.agent(options)`: open an agent session. `session.run(prompt)` sends one turn. Pass `{ result: zodObject }` to get validated structured output back; add `{ blocked: zodObject }` to let the agent report being stuck instead.
- `ctx.run(otherWorkflow, params)`: compose. The child runs with the same ctx wiring, its params validated, shown as one activity in the tree.
- `ctx.<role>` (for example `ctx.vcs`): the installed adapter for that role. See Adapter.

A workflow never prints, never parses argv, never touches a terminal. It talks to the world only through `ctx`.

## Adapter

An adapter connects workflows to one outside thing: git, GitHub, Jira, an agent CLI. It is a plain object with four fields:

```ts
import { adapter } from "penguin";

export default adapter({
  role: "vcs",
  name: "git",
  description: "git working copies: staging, commits, pushes",
  build: (host) => ({
    async commit(message: string) {
      const done = await host.shell(`git commit -m '${message}'`);
      return { ok: done.code === 0 };
    },
  }),
});
```

- `role` is the slot the adapter fills on ctx. A workflow calls `ctx.vcs.commit(...)` and does not care whether git or jj answers.
- `name` is which implementation this is. One role can have many; the user picks a default when there is more than one.
- `build(host)` returns the API the workflow calls. Every method call is recorded as a step in the run's events.

`host` is everything an adapter can touch: `shell` and `exec` to run commands, `state` for a folder that survives between runs, `wait` to mark the run idle while polling something slow, `gate` to ask the user when only a person can clear the way, and `emit` to write events.

One role is special: `agent`. An adapter with `role: "agent"` implements `turn(turn)` instead of a free-form API, and powers `ctx.agent`. It sends one prompt to an agent CLI and returns the result. `examples/adapters/claude.ts` is one.

## Message

A run is a detached process. Its whole surface is two append-only files in the run directory:

- `events.jsonl`: out. Every `ViewEvent` the run emits: state changes, steps, gates, agent output, facts. A frontend reads this file to show the run.
- `inbox.jsonl`: in. Every `Message` the outside world sends: an answer to a gate, or anything else. The run reads this file to hear the world.

That is the entire contract between a run and any frontend. A website, a desktop app, a CLI, a TUI: each is a window that tails `events.jsonl` and appends to `inbox.jsonl`. Closing the window never touches the run.

A `Message` is `{ text, session?, gate? }`. When a gate is open, the next message answers it (`gate` addresses a specific one). When no gate is open, messages queue for `ctx.messages.next()`.
