# Workflow model

A workflow is one self-contained TypeScript file: a **params schema** plus a **run function**. It imports only `wa` and `zod`. Reuse across workflows is copied functions. The params schema is what the engine must know before code runs. The run function is everything within a run's lifetime, written as code over `ctx`. Control flow, batching, and parallelism are the language.

```typescript
import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "one line of what this workflow does",
  params: z.object({ /* initial inputs */ }),
  async run(ctx) { /* body */ },
});
```

`description` is required: a non-empty string. `wa list workflows` reads it from the export. A file with no description fails to load.

`params` is a `z.object` schema. CLI args map onto its fields and are validated before the run is created. `wa list workflows` prints the fields as the params the workflow takes. A URL or file path is text the workflow hands to an agent.

wa imports the module and reads the exported params schema without calling `run`. Module top level is side-effect-free.

## The ctx API

`run(ctx)` receives everything. All IO goes through it. Every `await` on a journaled call is a durable checkpoint: the run can park there for days, survive process death, and resume.

- `ctx.params`: validated params.
- `ctx.gate(question)`: ask a question and wait for the answer. The question prints in the terminal when attached. The answer is free text. A workflow that wants fixed choices writes them into the question and loops on the answer. A workflow that needs two facts asks two gates. An unanswered gate parks the run: `wa resume` with a reply resumes it (`20-architecture.md`, run lifecycle). Returns the answer string.
- `ctx.agent(options?)`: open an agent session (below).
- `ctx.view`: the typed output surface (below). View calls are not journaled.
- One key per installed adapter role (`20-architecture.md`, adapters): `ctx.vcs`, `ctx.github`, and any role the user adds. Every method call is a journaled step. A key no adapter provides parks the run and names the installed roles.

Composition is native: `Promise.all` fans out, `Promise.race` takes the first, and both replay correctly because the journal records completion order. Helpers (a retry loop, a parallel map) are plain TypeScript over these primitives, written in the workflow file. A workflow that must wait on the outside world gates: a human or cron resumes it.

## Agent sessions

`ctx.agent(options?)` opens a session: one conversation with one agent implementation. The handle's scope is the conversation's life.

```typescript
const implementer = ctx.agent();              // one conversation across the whole run
for (let round = 1; round <= 3; round++) {
  await implementer.run("wa-implement", { input });   // each turn continues it
  const reviewer = ctx.agent();               // a fresh conversation each round
  const review = await reviewer.run("wa-review", { input, result: Review });
}
```

Options: `use` names the agent adapter implementation when more than one is installed, `cwd` sets the session's working directory, and any other field passes through to the adapter (the claude adapter reads `model`). Opening a session is a journaled step that records a generated session id, so a resumed run continues the same conversation.

`session.run(skill, {input, result})` is one turn. `skill` is a skill name or a path to a markdown file (skills below). `result` is a plain `z.object` schema. The turn must satisfy it: on mismatch the engine sends the validation error back into the same conversation and retries once, then gates to a human. A turn with no `result` returns nothing.

## The view

`ctx.view` posts typed objects. It never formats output, and nothing in a workflow knows what a terminal is. A view adapter renders the stream, and `events.jsonl` in the run directory keeps it for any other subscriber (`20-architecture.md`, events).

- `view.activity(label, body)`: a span with a start, an end, and a parent. The engine opens one per step by itself. A workflow opens one where it knows structure the engine cannot see (a review round wrapping two turns). Returns what `body` returns.
- `view.fact({name: value})`: what is true right now. A renderer overwrites facts, it never scrolls them.
- `view.event({message, level?, data?})`: what happened, in order.
- `view.artifact({title, path?, url?})`: a thing the run produced that a human can open.
- `view.watch({elapsed?, diff?})`: the live numbers the view samples: a running clock, a `git diff` stat for a path. The view does the sampling, so the workflow never reads a clock.

View calls are not journaled and never park a run.

## Determinism

The run function is a pure function of params plus journaled results. Three rules keep it one:

1. All IO goes through journaled ctx calls. The workflow reads no clock, no randomness, no environment, no files.
2. No module-level mutable state.
3. Code between two awaits is fast and side-effect-free. Long work belongs in a step.

View calls are exempt: they are output, not input, and replay reconstructs them.

Replay verifies the rules: each replayed call must match its journal entry. A mismatch parks the run with a divergence error before any side effect runs.

## Replay

Every journaled call records its result. Resume and crash recovery re-execute `run` from the top while the journal answers each call instantly, until execution reaches the first unanswered call and goes live. A run keeps a pinned copy of its workflow file, and replay executes the copy: editing a definition never changes an existing run.

Replay emits no view events. When the run goes live, the view re-announces what still stands: the open activities, the latest watch, and the merged facts. The scroll never repeats.

## Results and documents

Agent turns return a small typed envelope (zod-validated): verdicts, numbers, short strings, file paths. A result schema is a plain `z.object` with fields like `z.boolean()` and `z.enum([...])`. Params and results use the same zod vocabulary. How the envelope travels back is the agent adapter's concern, never the workflow's. Documents (a spec, a design note) are markdown files the agent writes where the workflow directs (a session `cwd`, a path passed in `input`) and references by path in the result. Models write documents best as plain markdown, so prose never lives inside JSON strings. `run` returns nothing: a result leaves the run as a file, an artifact, or one adapter call (a GitHub comment, a PR).

## Worktrees

`ctx.vcs.worktree.add(name)` creates a sibling worktree and returns its path, which later sessions take as `cwd`. Removal is always explicit: `ctx.vcs.worktree.remove(path)`. Nothing removes a worktree by itself, at any point in a run's life. A forgotten worktree costs disk. A removed one costs work.

## Skills

A skill is a markdown craft file: how to do one step well. The skill holds craft, and the workflow holds control flow. wa reads the file and sends its content with the turn prompt.

A turn names its skill two ways:

- **By name**, for example `wa-review`. The name is a directory that holds a `SKILL.md`, or one markdown file named for the skill. wa looks in the project skills roots, then the home skills roots (`20-architecture.md`, skills).
- **By path**, for example `./skills/review.md`, resolved against the workflow file. A path holds a `/` or starts with a `.`.

A name that resolves nowhere parks the run, and the error names every place wa looked.

## Run identity

A run's name is `<workflow file stem>-<n>`, unique across all runs. The name is the run's directory name and the handle in every command.

## Example

```typescript
import { workflow } from "wa";
import { z } from "zod";

const Triage = z.object({ actionable: z.boolean(), reason: z.string() });
const Plan = z.object({ spec: z.string(), acceptance: z.string() });
const Review = z.object({ verdict: z.enum(["approved", "changes_needed"]), findings: z.string() });

export default workflow({
  description: "ticket to merged PR",
  params: z.object({ ticket: z.string() }),

  async run({ params, agent, vcs, github, view, gate }) {
    const t = await agent().run("wa-triage", { input: params.ticket, result: Triage });
    if (!t.actionable) {
      await gate(`Not actionable: ${t.reason}`);
      return;
    }

    const planner = agent();
    let plan;
    do {
      plan = await planner.run("wa-plan", { input: params.ticket, result: Plan });
    } while ((await gate("Approve the plan? (approve / revise)")) !== "approve");

    const ws = await vcs.worktree.add(`wa-${params.ticket}`);
    view.watch({ elapsed: true, diff: ws.path });

    const implementer = agent({ cwd: ws.path });
    const findings: string[] = [];
    let approved = false;
    for (let round = 1; round <= 3 && !approved; round++) {
      approved = await view.activity(`round ${round} of 3`, async () => {
        view.fact({ round: `${round}/3` });
        await implementer.run("wa-implement", { input: plan.spec });
        const reviewer = agent({ cwd: ws.path });
        const review = await reviewer.run("wa-review", { input: plan.acceptance, result: Review });
        findings.push(review.findings);
        return review.verdict === "approved";
      });
    }
    if (!approved) await gate("Three review rounds. Take a look.");

    const pr = await github.pr.create({ cwd: ws.path });
    view.artifact({ title: "Pull request", url: pr.url });
    while ((await gate(`PR is up: ${pr.url} (address-feedback / done)`)) !== "done") {
      await agent({ cwd: ws.path }).run("wa-address-feedback");
    }
  },
});
```
