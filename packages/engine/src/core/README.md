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
import { adapter, Fault } from "penguin";

export default adapter({
  role: "vcs",
  name: "git",
  description: "git working copies",
  build: (host) => ({
    async commit(message: string) {
      const done = await host.shell(`git commit -m '${message}'`);
      if (done.code !== 0) throw new Fault(done.stderr.trim(), { fix: "agent" });
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
- **Answers are data, refusals are faults.** What a call can learn is data,
  including the negatives: `dirty: false`, a null pull request, a conflicted
  rebase. What the world refused to do is a thrown `Fault`: the network, a
  hook, a tool, a repo state in the way. The split is what lets workflows be
  happy-path scripts: they branch on answers and never see most faults.

An adapter may also declare `check(host)`: fast, local preflight the engine
runs before a root run starts, answering what blocks the run (a missing CLI,
a signed-out login, a folder that is no repo). Problems surface at second
zero, at one gate, instead of an hour in.

## Faults and the gate

A `Fault` an adapter throws and a workflow does not catch lands in the engine,
which holds the run at a gate instead of ending it. A fault built with
`{ fix: "agent" }` goes to a fixer agent first, bounded; then the person reads
what stopped the call and answers retry, stop, or an instruction for the
fixer. Retry runs the same call again, so adapter operations converge on a
goal (`vcs.sync`, `github.pr.ensure`) rather than fire a command once. A
workflow that wants different handling wraps the call in `attempt(() => ...)`,
which turns the gate off for that call so the `Fault` reaches its own catch;
everything outside an attempt is the engine's.

One role, many implementations. A workflow calls `ctx.vcs.commit(...)` and
does not care whether git or jj answers. When more than one implementation of
a role is installed, the user picks a default.

## The view is an adapter

The person watching a run is one outside thing, so they get one adapter: role
`view`. Its starter API is a handful of functions.

```ts
await view.show("staged 3 files");
await view.status("waiting for CI", { idle: true });
const branch = await view.ask("Which branch?", z.string());
```

`show` appends to the run's story. `status` replaces what the run does right
now, one mutable line a frontend draws with a spinner and a timer; `{ idle:
true }` marks a run parked on an outside event. `act` appends a tool call to
the story: an id, a name, a status, and what the call acted on; sending the
same id again updates that call in place, which is how a call moves from
running to done or failed and picks up its output. `ask` sends a question and
resolves when a person answers, validated against the shape when one is given.
An ask about a world that can die takes a premise: `ask(question, shape,
{ until })` withdraws the question when `until` settles first, and the caller
reads `isWithdrawn(answer)` and re-reads the world instead of acting on it.
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

A child workflow needs no lane of its own: `call` runs it as its own run,
with its own run file, and the tree a frontend shows is the parent chain those
files record.

The builtin implementation is `files`: shows land in the run's file, answers
and messages arrive through the run's inbox, and every frontend reads and
writes those files. A different view implementation shadows it just by being
installed.

## Agents are adapters

An agent CLI is one more outside thing. The starter `agent` role speaks in
plain data: `open(options)` returns a session id, `turn(session, ask)`
returns a handle with `output` (a stream of what the agent is doing) and
`value` (a promise of the result, typed when a result shape is given).
The ask is `{ skill, prompt? }` or a prompt string: reusable instructions
live as a catalog skill, the prompt carries only runtime data.

```ts
const session = await agent.open({ cwd: params.dir });
const turn = agent.turn(session, { skill: "commit" }, { result: Commit });
for await (const chunk of turn.output) await view.show(chunk.text);
const commit = await turn.value;
```

The workflow decides whether agent output reaches the view, and how. The
engine has no idea agents exist.

`stop(session)` ends the running turn, and the session survives for the next
one. A workflow that races `listen()` against `turn.value` can hear a person
and stop the agent, which is the whole steering story.

## Pause and resume

A run that did not finish is paused, whatever ended it: a person, a usage
limit, an error no retry clears, or a machine going down. It resumes in its own folder and takes up where
it left off. Two kinds of state make that work. The world is the state store
for the world: workflows are reconcilers, they ask adapters what is true before
acting, the way `commit` checks `vcs.dirty` first, so a resumed run re-reads
everything it asked of git, GitHub, or a shell. The run file is the state store
for what people and agents said: the answers a person gave and the values
agents returned replay from it, so nobody is asked twice and no turn is paid
for twice. A usage limit pauses the run and a frontend brings it back when the
limit clears. An error pauses it the same way but waits for a person, because
nothing about waiting fixes a 500 or an empty account.

## The engine

The engine has five jobs, and any feature that needs a sixth is either a new
adapter, a new workflow, or out of scope:

1. **Catalog.** Find workflow files, adapter files, and skill folders across catalog directories.
2. **Ctx.** Validate params and wire installed adapter roles onto ctx.
3. **Process.** Own the run's working directory and the processes it spawns.
4. **Trace.** Append each adapter call and outcome to the run file, which is
   what a frontend reads and what a resume replays from.
5. **Recovery.** Run each adapter's preflight checks before a root run, and hold
   uncaught faults at a gate: fixer agent first when the fault asks for one,
   then the person, then the same call again.

The engine does not route messages, hold state machines, retry agent turns,
render anything, or know one adapter role from another beyond view and agent,
which recovery reads to do its job.
