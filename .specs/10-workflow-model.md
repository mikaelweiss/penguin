# Workflow model

A workflow is one TypeScript file: a declarative **manifest** plus a **run function**. The manifest is what the daemon must know while the run is not running. The run function is everything within a run's lifetime, written as code over a small primitive API. Control flow, batching, and parallelism are the language, never a schema.

```typescript
import { workflow } from "wa";

export default workflow({
  // manifest fields
  name: "...",
  async run(ctx) { /* body */ },
});
```

## Manifest fields

Only `name` and `run` are required.

- `name`, `description`: kebab-case name, unique within its resolution scope.
- `params`: typed initial inputs (`param.text()`, `param.number()`, `param.url()`, `param.file()`, `param.enum()`, `param.bool()`). CLI args map onto them and are validated before the run is created. A param can also be an adapter type: `github.issue()` declares that the CLI value (a URL or id) goes to the github adapter, which resolves it into its typed object before the run starts. The body receives the typed object, never the raw string. The workflow names the adapter: nothing routes by inference.
- `triggers`: `manual` (default), `schedule.cron(expr)`, or an adapter subscription (`github.issue.labeled("wa")`). A subscription is a typed request with declarative arguments: the workflow states what it wants, and the adapter translates that into polling or webhooks. Workflow code never filters raw provider events. A trigger's typed payload fills the param declared with the same adapter type. Event and schedule triggers activate through a watcher run: `wa run <workflow>` with no params creates a run in state `watching` that receives matching events and spawns one body run per event. The watcher is a normal run: it shows in `wa ps`, and `wa stop` ends the listening. Catch-up over items that already match (open labeled issues, missed events) is workflow code: a step that lists them, never a manifest field or CLI flag.
- `dedup`: a key function. One live run per key value. `onDuplicate`: `ignore` (default), `queue`, or `join` (deliver the event to the existing run's mailbox).
- `pool`: `maxRuns` per project (default unlimited), `onOverflow: queue | ignore`, `priority` function over the trigger event. Queued triggers start in priority order, FIFO within equal priority, and re-check dedup when a slot opens.
- `limits`: `timeout`, `maxAgentCalls`, `maxDepth` (child workflows). Breaching a limit stops the run and gates to a human with the reason. The engine enforces limits, never the workflow code.
- `defaults`: agent and model for this workflow's steps. Absent by default: interactive invocations use the session's agent, headless invocations use `~/.wa/config.toml`.

Manifest extraction: the runner loads the module in the sandbox and reads the exported manifest without calling `run`. Module top level must be side-effect-free. Lint enforces this.

## The step API

`run(ctx)` receives everything. All IO goes through it. Every `await` on this API is a durable checkpoint: the run can park there for days, survive a daemon restart, and resume.

- `ctx.params`: validated params.
- `ctx.step.agent(skill, {input, result, executor, workspace, interrupt})`: run a skill on an agent. `result` is a zod schema. The agent must satisfy it: on mismatch the engine retries once with the validation error, then gates to a human. Returns the typed result.
- `ctx.step.command(cmd, {workspace})`: run a shell command. Returns `{code, stdout, stderr}`.
- `ctx.step.workspace({repo, base, keep})`: create an isolated worktree. Defaults: `repo` is the invoking folder's repository, `base` is the branch the invoking folder is on (a worktree resolves to its own branch). Removed when the run exits clean, kept on failure or `keep: true`. A workflow that never calls workspace or git runs fine in a plain folder with no repository. Multiple calls give multi-repo runs: `workspace({repo: "~/code/api"})` beside `workspace({repo: "~/code/web"})`.
- `ctx.step.spawn(workflowName, params)`: start a child run. Returns a handle: `h.result()` (await completion), `h.send(msg)`, `h.stop()`. `ctx.step.call(name, params)` is spawn plus await. Children see `parent` as a send target. Stopping a run stops its non-detached children, recursively.
- `ctx.gate(question, {options, reply})`: send a question and wait for the answer. `options` renders as choices in the cli and as buttons where a channel supports them. `reply` is a zod schema for structured answers. Delivered on every bound channel. The reply is validated like a result. The first valid reply wins. Returns the chosen option or the validated reply object.
- `ctx.send(target, msg)`: fire a message at a channel or a run handle. No wait.
- `ctx.receive(filter, {timeout})`: wait for the next matching message. `filter` is a mailbox predicate (`m => ...`) or an adapter subscription (`github.pr({url, events: ["merged"]})`). The subscription form also subscribes the daemon to matching events for exactly as long as the run waits there: the subscription is a visible line of workflow code with the lifetime of the wait. On timeout it returns `null`. Unconsumed messages stay in the mailbox in order. None drop.
- `ctx.sleep(duration)`, `ctx.now()`: journaled time. The only clock a workflow may use.
- `ctx.log(text)`: a line in the run log.

Composition is native: `Promise.all` fans out, `Promise.race` takes the first, and both replay correctly because the journal records completion order. The standard library (`collect`, `parallelMap`, `retry`, `pollUntil`) is plain TypeScript over these primitives: readable, copyable, and editable, never schema.

## Mid-step messages

A message that arrives while a step executes follows that step's `interrupt` option: a function from the message to one of three policies.

- `queue` (default): hold the message in the mailbox until the step ends.
- `inject`: pause the agent, deliver the message into the live session, and continue with the same context.
- `restart`: abort the step and dispatch it again from the start, with the message consumed as input.

The policy lives in the workflow body, next to the step it governs:

```typescript
await step.agent("review", {
  interrupt: m => m.type === "pr.commits" ? "restart" : "queue",
});
```

Only agent steps take `interrupt`. Every other step queues. `inject` requires an agent that accepts mid-session input: when the adapter cannot, the engine falls back to `restart`. Each restart counts toward `maxAgentCalls`, so a flood of messages cannot loop a step forever. The journal records the aborted attempt and the injected message, so replay stays deterministic.

## Determinism rules

Three rules, enforced by the sandbox and checked by lint:

1. All IO and time go through the step API. `Date.now`, `Math.random`, `fetch`, `fs`, and timers do not exist in the sandbox.
2. The run function is a pure function of params plus journaled results. No module-level mutable state, no environment reads.
3. Code between two awaits must be fast and side-effect-free. Long work belongs in a step.

## Replay

Every primitive call is journaled with its result. Resume, crash recovery, and daemon restart all re-execute `run` from the top while the journal answers each call instantly, until execution reaches the first unanswered call and goes live. A run pins the content hash of its compiled workflow file and keeps a copy: editing a definition never changes a live run.

## Results and artifacts

Agent steps return a small typed envelope (zod-validated): verdicts, numbers, short strings, artifact references. Result fields use zod types (`z.boolean()`, `z.enum([...])`). The `param.*` vocabulary declares workflow inputs only. Documents (a spec, a design note) are markdown files the agent writes to the run's `artifacts/` directory and references by path. Models write documents best as plain markdown, so prose never lives inside JSON strings. Outputs are whatever `run` returns: it flows to the parent for a `call`, and to stdout for `wa run --output json`. Any other destination (a GitHub issue, a file, Slack) is one `ctx.send` or `ctx.step.command` line.

## Skills

A skill is a markdown craft file: how to do one step well. It contains no control flow. Skills resolve like workflows and are referenced by name from `step.agent`. wa reads the resolved file and sends its content with the step prompt. The agent's own skill directories (`~/.claude/skills`, `~/.agents/skills`) play no part in resolution. `wa skills import` copies existing agent skills into wa's directories (`20-architecture.md`, commands).

## Resolution order

Repo `.wa/workflows/*.ts` and `.wa/skills/*.md`, then `~/.wa/workflows/` and `~/.wa/skills/`. First match wins. `wa which <name>` shows the source.

## Run identity

A cheap namer invocation (the default agent's cheap tier) names each run from its context at creation, with a static fallback. Names are the handle in every command, unique per project with a numeric suffix on collision. `wa rename` is free: a stable internal id sits underneath.

## Example

```typescript
import { workflow, result } from "wa";
import { github } from "wa/adapters";
import { z } from "zod";

const Triage = result({ actionable: z.boolean(), reason: z.string() });
const Plan = result({ spec: z.string(), acceptance: z.string() });
const Review = result({ verdict: z.enum(["approved", "changes_needed"]), findings: z.string() });

export default workflow({
  name: "ticket",
  description: "One labeled ticket, from triage to merged PR.",
  params: { ticket: github.issue() },
  triggers: [github.issue.labeled("wa")],
  dedup: ({ params }) => params.ticket.url,
  pool: { maxRuns: 5, onOverflow: "queue" },
  limits: { timeout: "3d", maxAgentCalls: 40 },

  async run({ params, step, gate, receive }) {
    const t = await step.agent("triage", { input: params.ticket, result: Triage });
    if (!t.actionable) {
      await gate(`Not actionable: ${t.reason}`);
      return;
    }

    let plan;
    do {
      plan = await step.agent("plan", { result: Plan });
    } while (
      (await gate("Approve the plan?", { options: ["approve", "revise"] })) === "revise"
    );

    const ws = await step.workspace({});
    let approved = false;
    for (let round = 0; round < 3 && !approved; round++) {
      await step.agent("implement", {
        input: plan.spec,
        workspace: ws,
        interrupt: m => m.source === "cli" ? "inject" : "queue",
      });
      const review = await step.agent("review", { input: plan.acceptance, workspace: ws, result: Review });
      approved = review.verdict === "approved";
    }
    if (!approved) await gate("Three review rounds. Take a look.");

    const pr = await step.command("gh pr create --fill", { workspace: ws });
    const prUrl = pr.stdout.trim();
    while (
      (await receive(github.pr({ url: prUrl, events: ["merged", "comment"] }))).type !== "pr.merged"
    ) {
      await step.agent("address-feedback", { workspace: ws });
    }
  },
});
```
