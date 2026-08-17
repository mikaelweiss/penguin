# Workflow model

A workflow is one TypeScript file: a **params schema** plus a **run function**. It imports `penguin`, `zod`, other workflow files, and shared TypeScript files by relative path. The params schema is what the engine must know before code runs. The run function is everything within a run's lifetime, written as code over `ctx`. Control flow, batching, and parallelism are the language.

```typescript
import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "one line of what this workflow does",
  params: z.object({ /* initial inputs */ }),
  async run(ctx) { /* body */ },
});
```

`description` is required: a non-empty string. `pn list workflows` reads it from the export. A file with no description fails to load.

`params` is a `z.object` schema. CLI args map onto its fields and are validated before the run is created. `--name value` fills the field it names. A bare value fills the first field nothing has filled yet, in the order the schema declares them, so the first param never needs its name. A boolean field is a flag only, and no bare value ever fills it. `pn list workflows` prints the fields as the params the workflow takes. A URL or file path is text the workflow hands to an agent.

penguin imports the module and reads the exported params schema without calling `run`. Module top level is side-effect-free.

## The ctx API

`run(ctx)` receives everything. All IO goes through it: a workflow can only do what an adapter offers.

- `ctx.params`: validated params.
- `ctx.gate(question, shape?)`: ask a question and wait for the answer. The run shows blocked with the question, and the answer arrives as a message from an attached viewer. With no shape the answer is free text, and the gate returns a string. With a zod shape (`z.number()`, `z.enum([...])`, `z.array(z.enum([...]))`, `z.boolean()`, `z.url()`) the gate returns that type. The engine takes the first reading of the answer text the shape accepts: the text itself, a number, yes or no, a comma-separated list, or JSON. An answer no reading fits gets a warning, and the gate asks the same question again. A shape checks the form of an answer, never its meaning, so a workflow that wants approval still loops on the answer. A workflow that needs two facts asks two gates.
- `ctx.agent(options?)`: open an agent session (below).
- `ctx.messages`: the inbound message stream (below).
- `ctx.view`: the typed output surface (below).
- One key per installed adapter role (`20-architecture.md`, adapters): `ctx.vcs`, `ctx.github`, and any role the user adds. A key no adapter provides ends the run and names the installed roles.

Parallelism is native: `Promise.all` fans out, `Promise.race` takes the first. Helpers (a retry loop, a parallel map) are plain TypeScript over these primitives.

A workflow never handles a key. An adapter that needs one asks the engine, and the engine asks the user the first time and remembers the answer (`20-architecture.md`, credentials).

## Agent sessions

`ctx.agent(options?)` opens a session: one conversation with one agent implementation. The handle's scope is the conversation's life.

```typescript
const implementer = ctx.agent();              // one conversation across the whole run
for (let round = 1; round <= 3; round++) {
  await implementer.run("penguin-implement", { input });   // each turn continues it
  const reviewer = ctx.agent();               // a fresh conversation each round
  const review = (await reviewer.run("penguin-review", { input, result: Review }))!;
}
```

Options: `use` names the agent adapter implementation when more than one is installed, `cwd` sets the session's working directory, `name` labels the session (a viewer shows it, and a message targets it; the default is the implementation name plus a counter), and any other field passes through to the adapter (the claude adapter reads `model`).

`session.run(skill, {input, result, blocked})` returns a **turn**. `skill` is a skill name or a path to a markdown file (skills below). `result` is a plain `z.object` schema. Await the turn for the result: on a schema mismatch the engine sends the validation error back into the same conversation and retries once, then gates to a human. A turn with no `result` resolves to null.

`blocked` is a second plain `z.object` schema, for a turn that may end needing the user. With both schemas the turn resolves to `{result}` or `{blocked}`, and the agent fills exactly one: a value that fills both, or neither, is a schema mismatch like any other. An agent has no channel to the user, so this envelope is how a question travels: the workflow reads which envelope came back, gates what blocks, and the next `session.run` on the same handle carries the answers into the same conversation. `blocked` without `result` fails the run.

`turn.stop()` ends the turn early: the engine kills the agent process, and the turn resolves to `undefined`. A turn's type is therefore `R | undefined`: a caller that never stops the turn asserts the result with `!`. The conversation keeps the partial work, and the next `session.run` on the same handle continues it. Stop then continue is how a workflow interrupts an agent with new information. A fresh `ctx.agent()` is how it starts over.

## Messages

`ctx.messages.next()` returns the next message sent into the run: `{text, session?}`. An attached viewer sends messages, addressed to the run or to a named session. The engine delivers each message once, in order, to the earliest waiting reader. A gate is a reader too: each ask posts its question and takes the next message as the answer.

A workflow chooses what a message means. Race it against a turn to allow interruption. Read it between turns to queue it. Never read it to ignore it.

```typescript
const implementer = ctx.agent({ name: "implementer", cwd: ws.path });
let turn = implementer.run("penguin-implement", { input: plan.spec });
let inbound = ctx.messages.next();
while (true) {
  const first = await Promise.race([turn.then(() => "turn"), inbound.then(() => "message")]);
  if (first === "turn") break;
  const message = await inbound;
  inbound = ctx.messages.next();
  await turn.stop();
  turn = implementer.run("penguin-implement", { input: `The user says: ${message.text}. Adjust and continue.` });
}
```

The outside world sends messages through adapters: an adapter method can return a subscription, an object whose `next()` resolves on the next item (a new commit on a PR, a new issue with a tag). The same race pattern applies, and the run shows idle while it waits (`20-architecture.md`, adapters).

## Composition

A workflow calls another workflow as a function:

```typescript
import triage from "./triage.ts";

const t = await triage(ctx, { ticket: params.ticket });
```

The call validates the arguments against the callee's params schema, runs the callee's run function on the same ctx with the callee's params, and returns what the callee returns. The engine wraps the call in an activity named for the callee, so the view shows the structure. A composed call creates no run: `pn ps` shows the root alone.

`run` may return a value. A composing caller receives it. At the root, `pn run` prints it.

## The view

`ctx.view` posts typed objects. It never formats output, and nothing in a workflow knows what a terminal is. A view adapter renders the stream, and `events.jsonl` in the run directory keeps it for any other subscriber (`20-architecture.md`, events).

- `view.activity(label, body)`: a span with a start, an end, and a parent. The engine opens one per step by itself. A workflow opens one where it knows structure the engine cannot see (a review round wrapping two turns). Returns what `body` returns.
- `view.fact({name: value})`: what is true right now. A renderer overwrites facts, it never scrolls them.
- `view.event({message, level?, data?})`: what happened, in order.
- `view.artifact({title, path?, url?})`: a thing the run produced that a human can open.
- `view.watch({elapsed?, diff?})`: the live numbers the view samples: a running clock, a `git diff` stat for a path. The view does the sampling, so the workflow never reads a clock.

## Results and documents

Agent turns return a typed envelope (zod-validated): verdicts, numbers, file paths, and the text the workflow passes onward (a plan, a task list, a findings report). A result schema is a plain `z.object` with fields like `z.boolean()` and `z.enum([...])`. Params and results use the same zod vocabulary. How the envelope travels back is the agent adapter's concern, never the workflow's. A document only a human opens, or one that must outlive the run, is a markdown file the agent writes where the workflow directs (a session `cwd`, a path passed in `input`) and references by path in the result. Larger outcomes leave the run as a file, an artifact, or one adapter call (a GitHub comment, a PR).

## Worktrees

`ctx.vcs.worktree.add(name)` creates a sibling worktree and returns its path, which later sessions take as `cwd`. Removal is always explicit: `ctx.vcs.worktree.remove(path)`. Nothing removes a worktree by itself, at any point in a run's life. A forgotten worktree costs disk. A removed one costs work.

## Skills

A skill is a markdown craft file: how to do one step well. The skill holds craft, and the workflow holds control flow. penguin reads the file and sends its content with the turn prompt.

A turn names its skill two ways:

- **By name**, for example `penguin-review`. The name is a directory that holds a `SKILL.md`, or one markdown file named for the skill. penguin looks in the project skills roots, then the home skills roots (`20-architecture.md`, skills).
- **By path**, for example `./skills/review.md`, resolved against the workflow file. A path holds a `/` or starts with a `.`.

A name that resolves nowhere ends the run, and the error names every place penguin looked.

## Run identity

A run's name is `<workflow file stem>-<n>`, unique across all runs. The name is the run's directory name and the handle in every command.

## Example

```typescript
import { workflow } from "penguin";
import { z } from "zod";

const Blocked = z.object({ questions: z.array(z.string()) });
const Triage = z.object({ actionable: z.boolean(), reason: z.string(), tasks: z.array(z.string()) });
const Plan = z.object({ plan: z.string(), acceptance: z.string() });
const Review = z.object({ verdict: z.enum(["approved", "changes_needed"]), findings: z.string() });

export default workflow({
  description: "ticket to merged PR",
  params: z.object({ ticket: z.string() }),

  async run({ params, agent, vcs, github, view, gate }) {
    const triager = agent();
    let out = (await triager.run("penguin-triage", { input: params.ticket, result: Triage, blocked: Blocked }))!;
    while (out.blocked !== undefined) {
      const answers: string[] = [];
      for (const question of out.blocked.questions) answers.push(`${question}\n${await gate(question)}`);
      out = (await triager.run("penguin-triage", { input: answers.join("\n\n"), result: Triage, blocked: Blocked }))!;
    }
    const t = out.result;
    if (!t.actionable) {
      await gate(`Not actionable: ${t.reason}`);
      return;
    }

    const ws = await vcs.worktree.add(`penguin-${params.ticket}`);
    view.watch({ elapsed: true, diff: ws.path });

    for (const task of t.tasks) {
      const planner = agent();
      let plan;
      do {
        plan = (await planner.run("penguin-plan", { input: task, result: Plan }))!;
      } while ((await gate(`${plan.plan}\n\nApprove the plan? (approve / revise)`)) !== "approve");

      const implementer = agent({ cwd: ws.path });
      const findings: string[] = [];
      let approved = false;
      for (let round = 1; round <= 3 && !approved; round++) {
        approved = await view.activity(`round ${round} of 3`, async () => {
          view.fact({ round: `${round}/3` });
          await implementer.run("penguin-implement", { input: plan.plan });
          const reviewer = agent({ cwd: ws.path });
          const review = (await reviewer.run("penguin-review", { input: plan.acceptance, result: Review }))!;
          findings.push(review.findings);
          return review.verdict === "approved";
        });
      }
      if (!approved) await gate("Three review rounds. Take a look.");
    }

    const pr = await github.pr.create({ cwd: ws.path });
    view.artifact({ title: "Pull request", url: pr.url });
    while ((await gate(`PR is up: ${pr.url} (address-feedback / done)`)) !== "done") {
      await agent({ cwd: ws.path }).run("penguin-address-feedback");
    }
  },
});
```
