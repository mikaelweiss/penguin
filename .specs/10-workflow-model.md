# Workflow model

A workflow is one self-contained TypeScript file: a **params schema** plus a **run function**. It imports only `wa` and `zod`. Reuse across workflows is copied functions. The params schema is what the engine must know before code runs. The run function is everything within a run's lifetime, written as code over a small primitive API. Control flow, batching, and parallelism are the language.

```typescript
import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  params: z.object({ /* initial inputs */ }),
  async run(ctx) { /* body */ },
});
```

`params` is a `z.object` schema. CLI args map onto its fields and are validated before the run is created. A URL or file path is text the workflow hands to a command.

wa imports the module and reads the exported params schema without calling `run`. Module top level is side-effect-free.

## The step API

`run(ctx)` receives everything. All IO goes through it. Every `await` on this API is a durable checkpoint: the run can park there for days, survive process death, and resume.

- `ctx.params`: validated params.
- `ctx.step.agent(skill, {input, result, agent, cwd})`: run a skill on an agent. `skill` is the path to a markdown file, relative to the workflow file. `result` is a plain `z.object` schema. The agent must satisfy it: on mismatch the engine retries once with the validation error, then gates to a human. `agent` is a shell command string that overrides the default agent (`20-architecture.md`, agents). Returns the typed result.
- `ctx.step.command(cmd, {cwd})`: run a shell command. Returns `{code, stdout, stderr}`. Provider IO (read a ticket, open a PR, add a worktree) is this primitive plus the provider's own CLI (`gh`, `linear`, `git`).
- `ctx.gate(question)`: ask a question and wait for the answer. The question prints in the terminal when attached. The answer is free text. A workflow that wants fixed choices writes them into the question and loops on the answer. A workflow that needs two facts asks two gates. An unanswered gate parks the run: `wa resume` with a reply resumes it (`20-architecture.md`, run lifecycle). Returns the answer string.

`cwd` sets a step's working directory, resolved from the invoking folder, which is the default. A worktree is one `git worktree add` through `step.command`, its path passed as `cwd` to later steps. Cleanup is `git worktree remove` by hand.

Composition is native: `Promise.all` fans out, `Promise.race` takes the first, and both replay correctly because the journal records completion order. Helpers (a retry loop, a parallel map, a worktree maker) are plain TypeScript over these primitives, written in the workflow file. A workflow that must wait on the outside world gates: a human or cron resumes it.

## Determinism

The run function is a pure function of params plus journaled results. Three rules keep it one:

1. All IO goes through the step API. The workflow reads no clock, no randomness, no environment, no files.
2. No module-level mutable state.
3. Code between two awaits is fast and side-effect-free. Long work belongs in a step.

Replay verifies the rules: each replayed call must match its journal entry. A mismatch parks the run with a divergence error before any side effect runs.

## Replay

Every primitive call is journaled with its result. Resume and crash recovery re-execute `run` from the top while the journal answers each call instantly, until execution reaches the first unanswered call and goes live. A run keeps a pinned copy of its workflow file, and replay executes the copy: editing a definition never changes an existing run.

## Results and documents

Agent steps return a small typed envelope (zod-validated): verdicts, numbers, short strings, file paths. A result schema is a plain `z.object` with fields like `z.boolean()` and `z.enum([...])`. Params and results use the same zod vocabulary. Documents (a spec, a design note) are markdown files the agent writes where the workflow directs (a `cwd`, a path passed in `input`) and references by path in the result. Models write documents best as plain markdown, so prose never lives inside JSON strings. `run` returns nothing: a result leaves the run as a file or through one `ctx.step.command` line (a GitHub comment, a PR).

## Skills

A skill is a markdown craft file: how to do one step well. The skill holds craft, and the workflow holds control flow. A step references its skill by path, relative to the workflow file. wa reads the file and sends its content with the step prompt.

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
  params: z.object({ ticket: z.string() }),

  async run({ params, step, gate }) {
    const t = await step.agent("./skills/triage.md", { input: params.ticket, result: Triage });
    if (!t.actionable) {
      await gate(`Not actionable: ${t.reason}`);
      return;
    }

    let plan;
    do {
      plan = await step.agent("./skills/plan.md", { result: Plan });
    } while ((await gate("Approve the plan? (approve / revise)")) !== "approve");

    const ws = `../wa-${params.ticket}`;
    await step.command(`git worktree add ${ws}`);
    let approved = false;
    for (let round = 0; round < 3 && !approved; round++) {
      await step.agent("./skills/implement.md", { input: plan.spec, cwd: ws });
      const review = await step.agent("./skills/review.md", { input: plan.acceptance, cwd: ws, result: Review });
      approved = review.verdict === "approved";
    }
    if (!approved) await gate("Three review rounds. Take a look.");

    const pr = await step.command("gh pr create --fill", { cwd: ws });
    while ((await gate(`PR is up: ${pr.stdout.trim()} (address-feedback / done)`)) !== "done") {
      await step.agent("./skills/address-feedback.md", { cwd: ws });
    }
  },
});
```
