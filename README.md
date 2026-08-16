# wa

wa runs one workflow as a foreground process, against any repository, with any coding agent CLI.

A workflow is one TypeScript file: a params schema and a run function over three primitives. The engine journals every call. A run parks at a gate for days, and one command resumes it.

## Install

```sh
npm install -g wa
```

wa needs Node 24 or newer. Your repository needs no npm install.

## Install

```sh
wa install
```

The first wa command runs it for you. It creates `~/.wa/` and asks which skill directories wa should use, `~/.claude/skills` and `~/.agents/skills`. Arrows move, space toggles, enter confirms. When both hold a skill of the same name it asks which directory you prefer.

```
skills in ~/.wa/skills
  claude -> ~/.claude/skills  (preferred)
  agents -> ~/.agents/skills
  1 skill is in both: review
  a skill you add later shows up on its own
```

wa links the whole directory, so a skill you write next week is there already. Run `wa sync-skills` only to change which directories wa uses:

```sh
wa sync-skills --global   # ~/.claude/skills and ~/.agents/skills    -> ~/.wa/skills
wa sync-skills --local    # <repo>/.claude/skills and .agents/skills -> <repo>/.wa/skills
```

Sync writes symlinks and the `.order` file, nothing else. A skill you wrote into `~/.wa/skills/` yourself stays, and it wins the name.

## Start from the catalog

The package ships an example catalog. Copy what you want:

```sh
wa=$(npm root -g)/wa
cp "$wa/examples/agent" ~/.wa/agent
cp "$wa/examples/ticket.ts" ~/.wa/ticket.ts
cp -r "$wa/examples/skills/." ~/.wa/skills/
cp "$wa/examples/tsconfig.json" ~/.wa/tsconfig.json
```

`~/.wa/agent` holds one line: the shell command that runs your agent, for example `claude -p`.

Workflow files live in `~/.wa/` for every repository, or in `<repo>/.wa/` for one. Skills live next to them, in `skills/`.

## Write a workflow

```typescript
import { workflow } from "wa";
import { z } from "zod";

const Triage = z.object({ actionable: z.boolean(), reason: z.string() });

export default workflow({
  params: z.object({ ticket: z.string() }),

  async run({ params, step, gate }) {
    const t = await step.agent("wa-triage", { input: params.ticket, result: Triage });
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
wa list                           # the workflows and the skills wa can use
wa list workflows                 # just the workflows
wa list skills                    # just the skills, and where each one comes from
wa run ticket --ticket ABC-123    # by name, or by path: wa run ./ticket.ts
wa ps                             # every run and its state
wa resume ticket-1 approve
```

`list` is how you see what wa has. `run` validates the params against the schema, creates the run, and executes it; with no workflow it lists them, as bare `wa` does. `ps` prints every run with its state. `resume` replays the journal and continues, with an optional reply for the pending gate.

```
$ wa list skills
SKILL      SCOPE   SOURCE  FILE
wa-triage  global  wa      ~/.wa/skills/wa-triage
review     global  claude  ~/.claude/skills/review
migrate    global  agents  ~/.agents/skills/migrate
```

One row per name, in the order a step resolves them. A name held by two directories shows the winner.

## The step API

- `ctx.params`: the validated params.
- `ctx.step.agent(skill, {input, result, agent, cwd})`: run a skill on an agent. `skill` is a name from your skills directories, or a path to a markdown file. The engine validates the result against the schema.
- `ctx.step.command(cmd, {cwd})`: run a shell command. Provider work is this primitive plus `gh`, `linear`, or `git`.
- `ctx.gate(question)`: ask a question and wait for the answer.

Every await on this API is a durable checkpoint. Control flow, batching, and parallelism are plain TypeScript.

## Keep the run replayable

1. Send all IO through the step API. Read no clock, no randomness, no environment, no files.
2. Hold no module-level mutable state.
3. Keep the code between two awaits fast and free of side effects.

## Where the state lives

`~/.wa/` holds your workflow files, `skills/`, `agent`, and `runs/`. `~/.wa/runs/<run>/` holds `journal.jsonl`, the pinned copy of the workflow file, the agent transcripts, and the lock. To discard a run, delete the directory. Set `WA_HOME` to move the whole tree.

`<repo>/.wa/` holds the workflow files and skills of one repository, and ships in git.

## Specs

`.specs/` is the source of truth for the design.
