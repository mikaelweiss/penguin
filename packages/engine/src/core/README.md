# The model

penguin has two definitions. Everything else is a value passing between them.

| Definition | One line                                                                |
| ---------- | ----------------------------------------------------------------------- |
| Workflow   | A pure script. It orchestrates adapters and decides what people see.    |
| Adapter    | A workflow's bridge to one outside thing. Functions over plain data.    |

There is no third concept. A message stream is not a definition, it is a return
value: an adapter function that hands back an `AsyncIterable`. The view is not
engine machinery, it is an adapter whose outside thing is the person watching.

## Workflow

A workflow is a plain object: a description, a Zod params schema, and `run(ctx)`.

```ts
import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "what this does, one line",
  params: z.object({ dir: z.string().optional() }),

  async run({ params, vcs, view }) {
    const state = await vcs.dirty({ cwd: params.dir });
    await view.show(state.dirty ? "tree is dirty" : "tree is clean");
    return { dirty: state.dirty };
  },
});
```

`ctx` is the validated params plus one entry per installed adapter role. That
is all it is. A workflow touches the world only through `ctx`: it never prints,
never parses argv, never spawns a process, never reads a file on its own.

The workflow is the only orchestrator and the only narrator. It calls adapter
functions, consumes the streams they return, and decides what reaches the view.
Nothing shows a person anything unless workflow code sent it.

Workflows compose by function call. `call` parses the child's params and runs
it with the same ctx:

```ts
import { call } from "penguin";
import commit from "./commit.ts";

const done = await call(ctx, commit, { dir: "packages/engine" });
```

Parallel children are `Promise.all` over `call`. No engine machinery involved.

## Adapter

An adapter connects workflows to one outside thing: git, GitHub, an agent CLI,
the person watching. It is a role, a name, a description, and `build(host)`,
which returns the functions a workflow calls through `ctx.<role>`.

```ts
import { adapter } from "penguin";

export default adapter({
  role: "vcs",
  name: "git",
  description: "git working copies",
  build: (host) => ({
    async commit(message: string) {
      const done = await host.shell(`git commit -m '${message}'`);
      return { ok: done.code === 0, reason: done.stderr.trim() };
    },
  }),
});
```

`host` is everything an adapter can touch: `cwd` (the invoking folder),
`state` (a folder that survives between runs), `shell`, and `exec`. Nothing
else. An adapter cannot write to the view, cannot ask the user anything, and
cannot reach another adapter. It bridges, and that is all.

Two rules keep adapters honest:

- **Functions carry plain data.** An adapter function takes and returns
  JSON-serializable values, streams of them, or handles composed of those,
  the way `agent.turn` returns `{ output, value }`, a stream and a promise.
  What flows through is always plain data. Arbitrary objects with methods
  never cross the boundary.
- **Expected outcomes are data, thrown errors mean the bridge broke.** A failed
  commit returns `{ ok: false, reason }` for the workflow to handle. A throw
  means the adapter itself could not do its job at all.

One role, many implementations. A workflow calls `ctx.vcs.commit(...)` and
does not care whether git or jj answers. When more than one implementation of
a role is installed, the user picks a default.

## The view is an adapter

The person watching a run is one outside thing, so they get one adapter: role
`view`. Its starter API is two functions.

```ts
await view.show("staged 3 files");
const branch = await view.ask("Which branch?", z.string());
```

`show` sends something to whoever is watching. `ask` sends a question and
resolves when a person answers, validated against the shape when one is given.
The shape is the whole input system: a bool, an enum, an array of enums, an
object; a frontend renders whatever control fits it. Each call is its own
request with its own response. There is no shared inbox, no queue, and no
routing: an answer reaches its asker because the asker is the one awaiting it.
Two parallel branches asking at once are two pending questions, each answer
flowing back to its own caller.

`listen()` is the other direction: an async stream of messages a person sends
without being asked. Calling it is opting in, each stream is private to its
caller, and a message reaches its listener because the listener holds the
iterator. The same no-inbox law as `ask`, pointed the other way.

`scope(name)` returns a view whose calls carry a path, so a parent workflow
can give a child its own lane (`call({ ...ctx, view: view.scope(dir) }, ...)`).
The tree a frontend shows is the narration the workflows chose, and the engine
never learns it exists.

How a view implementation talks to its frontend (a terminal, files, a socket,
a web page), and whether it persists what it showed, is that implementation's
business, not the engine's.

## Agents are adapters

An agent CLI is one more outside thing. The starter `agent` role speaks in
plain data: `open(options)` returns a session id, `turn(session, prompt)`
returns a handle with `output` (a stream of what the agent is doing) and
`value` (a promise of the result, typed when a result shape is given).

```ts
const session = await agent.open({ cwd: params.dir });
const turn = agent.turn(session, PROMPT, { result: Commit });
for await (const chunk of turn.output) await view.show(chunk.text);
const commit = await turn.value;
```

The workflow decides whether agent output reaches the view, and how. The
engine has no idea agents exist.

`stop(session)` ends the running turn, and the session survives for the next
one. A workflow that races `listen()` against `turn.value` can hear a person
and stop the agent, which is the whole steering story.

## Resume

Workflows are reconcilers. They inspect the world through adapters before
acting, and act only on what is missing, the way `commit` checks `vcs.dirty`
first. So resuming an interrupted run is running the workflow again: its own
checks skip what is already done. The world is the state store. There is no
journal and no replay.

## The engine

The engine has four jobs, and any feature that needs a fifth is either a new
adapter, a new workflow, or out of scope:

1. **Catalog.** Find workflow and adapter files across catalog directories (`src/catalog/`).
2. **Ctx.** Validate params and wire installed adapter roles onto ctx (`src/run.ts`).
3. **Process.** Own the run's working directory and the processes it spawns (`src/host.ts`).
4. **Trace.** Append each adapter call and outcome to a log, for debugging (`src/trace.ts`).

The engine does not route messages, hold state machines, retry agent turns,
render anything, or know one adapter role from another.
