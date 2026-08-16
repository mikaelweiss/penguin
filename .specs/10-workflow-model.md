# Workflow model

A workflow is one TypeScript file: a declarative **manifest** plus a **run function**. The manifest is what the engine must know before code runs. The run function is everything within a run's lifetime, written as code over a small primitive API. Control flow, batching, and parallelism are the language, never a schema.

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
- `params`: typed initial inputs (`param.text()`, `param.number()`, `param.enum()`, `param.bool()`). CLI args map onto them and are validated before the run is created. A URL or file path is text the workflow hands to a command.
- `limits`: `maxAgentCalls`. Breaching it parks the run with a gate that states the reason. The engine enforces the limit, never the workflow code.
- `defaults`: agent and model for this workflow's steps. Absent by default: `~/.wa/config.toml` decides.

Manifest extraction: wa loads the module in the sandbox and reads the exported manifest without calling `run`. Module top level must be side-effect-free. Lint enforces this.

## The step API

`run(ctx)` receives everything. All IO goes through it. Every `await` on this API is a durable checkpoint: the run can park there for days, survive process death, and resume.

- `ctx.params`: validated params.
- `ctx.step.agent(skill, {input, result, executor, workspace})`: run a skill on an agent. `result` is a plain `z.object` schema. The agent must satisfy it: on mismatch the engine retries once with the validation error, then gates to a human. Returns the typed result.
- `ctx.step.command(cmd, {workspace})`: run a shell command. Returns `{code, stdout, stderr}`. Provider IO (read a ticket, open a PR, post a comment) is this primitive plus the provider's own CLI.
- `ctx.step.workspace({repo, base, keep})`: create an isolated worktree. Defaults: `repo` is the invoking folder's repository, `base` is the branch the invoking folder is on (a worktree resolves to its own branch). Removed when the run exits clean, kept on failure or `keep: true`. A workflow that never calls workspace or git runs fine in a plain folder with no repository. Multiple calls give multi-repo runs: `workspace({repo: "~/code/api"})` beside `workspace({repo: "~/code/web"})`.
- `ctx.gate(question, {options})`: ask a question and wait for the answer. The question prints in the terminal when attached, and `options` renders as choices. The answer is one of `options` when given, else free text. A workflow that needs two facts asks two gates. An unanswered gate parks the run: `wa answer` resumes it (`20-architecture.md`, run lifecycle). Returns the answer string.
- `ctx.sleep(duration)`, `ctx.now()`: journaled time. The only clock a workflow may use. A sleeping run waits in the foreground. Parked and resumed later, it continues immediately when the wake time has passed, else waits the remainder.
- `ctx.log(text)`: a line in the run log.

Composition is native: `Promise.all` fans out, `Promise.race` takes the first, and both replay correctly because the journal records completion order. The standard library (`collect`, `parallelMap`, `retry`, `pollUntil`) is plain TypeScript over these primitives: readable, copyable, and editable, never schema. Reuse across workflows is plain functions.

## Determinism rules

Three rules, enforced by the sandbox and checked by lint:

1. All IO and time go through the step API. `Date.now`, `Math.random`, `fetch`, `fs`, and timers do not exist in the sandbox.
2. The run function is a pure function of params plus journaled results. No module-level mutable state, no environment reads.
3. Code between two awaits must be fast and side-effect-free. Long work belongs in a step.

## Replay

Every primitive call is journaled with its result. Resume and crash recovery re-execute `run` from the top while the journal answers each call instantly, until execution reaches the first unanswered call and goes live. A run pins the content hash of its compiled workflow file and keeps a copy: editing a definition never changes an existing run.

## Results and artifacts

Agent steps return a small typed envelope (zod-validated): verdicts, numbers, short strings, artifact references. A result schema is a plain `z.object` with fields like `z.boolean()` and `z.enum([...])`. The `param.*` vocabulary declares workflow inputs only. Documents (a spec, a design note) are markdown files the agent writes to the run's `artifacts/` directory and references by path. Models write documents best as plain markdown, so prose never lives inside JSON strings. Outputs are whatever `run` returns: `wa run --output json` prints it to stdout. Any other destination (a GitHub issue, a file) is one `ctx.step.command` line.

## Skills

A skill is a markdown craft file: how to do one step well. It contains no control flow. Skills resolve like workflows and are referenced by name from `step.agent`. wa reads the resolved file and sends its content with the step prompt. The agent's own skill directories (`~/.claude/skills`, `~/.agents/skills`) play no part in resolution. `wa skills import` copies existing agent skills into wa's directories (`20-architecture.md`, commands).

## Resolution order

Repo `.wa/workflows/*.ts` and `.wa/skills/*.md`, then `~/.wa/workflows/` and `~/.wa/skills/`. First match wins. `wa which <name>` shows the source.

## Run identity

A run's name is `<workflow>-<n>`, unique per project. Names are the handle in every command. A stable internal id sits underneath.

## Example

```typescript
import { workflow, param } from "wa";
import { z } from "zod";

const Triage = z.object({ actionable: z.boolean(), reason: z.string() });
const Plan = z.object({ spec: z.string(), acceptance: z.string() });
const Review = z.object({ verdict: z.enum(["approved", "changes_needed"]), findings: z.string() });

export default workflow({
  name: "ticket",
  description: "One ticket, from triage to merged PR.",
  params: { ticket: param.text() },
  limits: { maxAgentCalls: 40 },

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

    const ws = await step.workspace({});
    let approved = false;
    for (let round = 0; round < 3 && !approved; round++) {
      await step.agent("implement", { input: plan.spec, workspace: ws });
      const review = await step.agent("review", { input: plan.acceptance, workspace: ws, result: Review });
      approved = review.verdict === "approved";
    }
    if (!approved) await gate("Three review rounds. Take a look.");

    const pr = await step.command("gh pr create --fill", { workspace: ws });
    while (
      (await gate(`PR is up: ${pr.stdout.trim()}.`, { options: ["address-feedback", "done"] })) === "address-feedback"
    ) {
      await step.agent("address-feedback", { workspace: ws });
    }
  },
});
```
