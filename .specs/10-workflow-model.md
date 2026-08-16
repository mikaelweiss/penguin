# Workflow model

A workflow is one self-contained TypeScript file: a declarative **manifest** plus a **run function**. It imports only `wa` and `zod`. Local imports do not exist: reuse across workflows is copied functions, not shared modules. The manifest is what the engine must know before code runs. The run function is everything within a run's lifetime, written as code over a small primitive API. Control flow, batching, and parallelism are the language, never a schema.

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
- `params`: a `z.object` schema for the initial inputs. CLI args map onto its fields and are validated before the run is created. A URL or file path is text the workflow hands to a command.

Manifest extraction: wa loads the module in the sandbox and reads the exported manifest without calling `run`. Module top level must be side-effect-free.

## The step API

`run(ctx)` receives everything. All IO goes through it. Every `await` on this API is a durable checkpoint: the run can park there for days, survive process death, and resume.

- `ctx.params`: validated params.
- `ctx.step.agent(skill, {input, result, executor, cwd})`: run a skill on an agent. `result` is a plain `z.object` schema. The agent must satisfy it: on mismatch the engine retries once with the validation error, then gates to a human. Returns the typed result.
- `ctx.step.command(cmd, {cwd})`: run a shell command. Returns `{code, stdout, stderr}`. Provider IO (read a ticket, open a PR, add a worktree) is this primitive plus the provider's own CLI (`gh`, `linear`, `git`).
- `ctx.gate(question, {options})`: ask a question and wait for the answer. The question prints in the terminal when attached, and `options` renders as choices. The answer is one of `options` when given, else free text. A workflow that needs two facts asks two gates. An unanswered gate parks the run: `wa resume` with a reply resumes it (`20-architecture.md`, run lifecycle). Returns the answer string.

`cwd` sets a step's working directory, resolved from the invoking folder, which is the default. A worktree is one `git worktree add` through `step.command`, its path passed as `cwd` to later steps. wa never removes one: cleanup is `git worktree remove` by hand.

Composition is native: `Promise.all` fans out, `Promise.race` takes the first, and both replay correctly because the journal records completion order. Helpers (a retry loop, a parallel map, a worktree maker) are plain TypeScript over these primitives, written in the workflow file. A workflow that must wait on the outside world gates: a human or cron resumes it.

## Determinism rules

Three rules, enforced by the sandbox:

1. All IO goes through the step API. A workflow cannot observe time: `Date.now`, `Math.random`, `fetch`, `fs`, and timers do not exist in the sandbox.
2. The run function is a pure function of params plus journaled results. No module-level mutable state, no environment reads.
3. Code between two awaits must be fast and side-effect-free. Long work belongs in a step.

## Replay

Every primitive call is journaled with its result. Resume and crash recovery re-execute `run` from the top while the journal answers each call instantly, until execution reaches the first unanswered call and goes live. A run keeps a pinned copy of its workflow file, and replay executes the copy: editing a definition never changes an existing run.

## Results and artifacts

Agent steps return a small typed envelope (zod-validated): verdicts, numbers, short strings, artifact references. A result schema is a plain `z.object` with fields like `z.boolean()` and `z.enum([...])`. Params and results use the same zod vocabulary. Documents (a spec, a design note) are markdown files the agent writes to the run's `artifacts/` directory and references by path. Models write documents best as plain markdown, so prose never lives inside JSON strings. `run` returns nothing: a result leaves the run as an artifact or through one `ctx.step.command` line (a GitHub comment, a file).

## Skills

A skill is a markdown craft file: how to do one step well. It contains no control flow. Skills resolve like workflows and are referenced by name from `step.agent`. wa reads the resolved file and sends its content with the step prompt. The agent's own skill directories (`~/.claude/skills`, `~/.agents/skills`) play no part in resolution. To import an existing agent skill, copy the file into a wa skills directory.

## Resolution order

Repo `.wa/workflows/*.ts` and `.wa/skills/*.md`, then `~/.wa/workflows/` and `~/.wa/skills/`. First match wins.

## Run identity

A run's name is `<workflow>-<n>`, unique across all runs. The name is the run's directory name and the handle in every command. There is no other id.

## Example

```typescript
import { workflow } from "wa";
import { z } from "zod";

const Triage = z.object({ actionable: z.boolean(), reason: z.string() });
const Plan = z.object({ spec: z.string(), acceptance: z.string() });
const Review = z.object({ verdict: z.enum(["approved", "changes_needed"]), findings: z.string() });

export default workflow({
  name: "ticket",
  description: "One ticket, from triage to merged PR.",
  params: z.object({ ticket: z.string() }),

  async run({ params, step, gate }) {
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

    const ws = `../wa-${params.ticket}`;
    await step.command(`git worktree add ${ws}`);
    let approved = false;
    for (let round = 0; round < 3 && !approved; round++) {
      await step.agent("implement", { input: plan.spec, cwd: ws });
      const review = await step.agent("review", { input: plan.acceptance, cwd: ws, result: Review });
      approved = review.verdict === "approved";
    }
    if (!approved) await gate("Three review rounds. Take a look.");

    const pr = await step.command("gh pr create --fill", { cwd: ws });
    while (
      (await gate(`PR is up: ${pr.stdout.trim()}.`, { options: ["address-feedback", "done"] })) === "address-feedback"
    ) {
      await step.agent("address-feedback", { cwd: ws });
    }
  },
});
```
