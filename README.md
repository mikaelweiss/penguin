# wa

wa runs one workflow as a foreground process, against any repository, with any coding agent CLI.

A workflow is one TypeScript file: a params schema and a run function over three primitives. The engine journals every call. A run parks at a gate for days, and one command resumes it.

## Install

```sh
npm install -g wa
```

wa needs Node 24 or newer. Your repository needs no npm install.

## Start from the catalog

The package ships an example catalog. Copy what you want:

```sh
wa=$(npm root -g)/wa
mkdir -p ~/.wa && cp "$wa/examples/agent" ~/.wa/agent
cp "$wa/examples/ticket.ts" ./ticket.ts
cp -r "$wa/examples/skills" ./skills
cp "$wa/examples/tsconfig.json" ./tsconfig.json
```

`~/.wa/agent` holds one line: the shell command that runs your agent, for example `claude -p`.

## Write a workflow

```typescript
import { workflow } from "wa";
import { z } from "zod";

const Triage = z.object({ actionable: z.boolean(), reason: z.string() });

export default workflow({
  params: z.object({ ticket: z.string() }),

  async run({ params, step, gate }) {
    const t = await step.agent("./skills/triage.md", { input: params.ticket, result: Triage });
    if (!t.actionable) {
      await gate(`Not actionable: ${t.reason}`);
      return;
    }
    await step.command("gh pr create --fill");
  },
});
```

## Run it

```sh
wa run ./ticket.ts --ticket ABC-123
wa list
wa resume ticket-1 approve
```

`run` validates the params against the schema, creates the run, and executes it. `resume` replays the journal and continues, with an optional reply for the pending gate. `list` prints every run with its state.

## The step API

- `ctx.params`: the validated params.
- `ctx.step.agent(skill, {input, result, agent, cwd})`: run a skill on an agent. The engine validates the result against the schema.
- `ctx.step.command(cmd, {cwd})`: run a shell command. Provider work is this primitive plus `gh`, `linear`, or `git`.
- `ctx.gate(question)`: ask a question and wait for the answer.

Every await on this API is a durable checkpoint. Control flow, batching, and parallelism are plain TypeScript.

## Keep the run replayable

1. Send all IO through the step API. Read no clock, no randomness, no environment, no files.
2. Hold no module-level mutable state.
3. Keep the code between two awaits fast and free of side effects.

## Where the state lives

`~/.wa/runs/<run>/` holds `journal.jsonl`, the pinned copy of the workflow file, the agent transcripts, and the lock. To discard a run, delete the directory. Set `WA_HOME` to move the whole tree.

## Specs

`.specs/` is the source of truth for the design.
