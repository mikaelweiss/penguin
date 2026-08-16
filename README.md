# wa

wa runs one workflow as a foreground process, against any repository, with any coding agent CLI.

A workflow is one TypeScript file: a params schema and a run function over `ctx`. The engine journals every call. A run parks at a gate for days, and one command resumes it.

## Install

```sh
npm install -g wa
```

wa needs Node 24 or newer. Your repository needs no npm install.

The first wa command sets up `~/.wa/` and copies the starter catalog into it:

```
created ~/.wa
run `wa list workflows` to see what's available and then `wa run <workflow>` from a project directory to get started
```

On a terminal it also asks which skill directories wa should link, `~/.claude/skills` and `~/.agents/skills`. Arrows move, space toggles, enter confirms. When both hold a skill of the same name it asks which directory you prefer. wa links the whole directory, so a skill you write next week is there already. Run `wa sync-skills` to choose again:

```sh
wa sync-skills --global   # ~/.claude/skills and ~/.agents/skills    -> ~/.wa/skills
wa sync-skills --local    # <repo>/.claude/skills and .agents/skills -> <repo>/.wa/skills
```

Sync writes symlinks and the `.order` file, nothing else. A skill you wrote into `~/.wa/skills/` yourself stays, and it wins the name.

## The starter catalog

Install fills `~/.wa/` with four workflows, their skills, four adapters, and a tsconfig for editor types:

- `wa run ticket --ticket ABC-123`: ticket to merged PR: triage, plan, plan gate, implement, review loop, PR, feedback loop.
- `wa run task --task "..."`: one small change in the current repository: implement, review loop, then a commit gate.
- `wa run fix --bug "..."`: reproduce the bug, fix it in a loop your repository's own checks close, PR, feedback loop.
- `wa run review --pr 42`: fetch the PR diff, review it into a findings file, then a gate that posts it as a PR comment.

`~/.wa/adapters/` holds the adapters: `claude` (the agent), `git`, `gh`, and `terminal`. Every catalog entry is an ordinary file after the copy: edit, delete, or replace it freely.

Workflow files live in `~/.wa/` for every repository, or in `<repo>/.wa/` for one. Skills and adapters live next to them, in `skills/` and `adapters/`.

## Write a workflow

```typescript
import { workflow } from "wa";
import { z } from "zod";

const Triage = z.object({ actionable: z.boolean(), reason: z.string() });

export default workflow({
  description: "ticket to merged PR",
  params: z.object({ ticket: z.string() }),

  async run({ params, agent, github, gate }) {
    const t = await agent().run("wa-triage", { input: params.ticket, result: Triage });
    if (!t.actionable) {
      await gate(`Not actionable: ${t.reason}`);
      return;
    }
    await github.pr.create();
  },
});
```

## Run it

```sh
wa list workflows                 # name, params, and description
wa list skills --verbose          # plus scope, source, and file
wa list adapters                  # role, implementation, and description
wa run ticket --ticket ABC-123    # by name, or by path: wa run ./ticket.ts
wa ps                             # every run and its state
wa resume ticket-1 approve
```

`list` is how you see what wa has. Each entry is a block: the name and the params it takes, then the description under it. `--verbose` adds a line for where the entry comes from. `run` validates the params against the schema, creates the run, and executes it; with no workflow it lists them. It opens with one line, the run name and the agent it uses:

```
$ wa run task --task "rename the flag"
run task-1 started, agent claude
```

Bare `wa` prints the usage. `ps` prints every run with its state. `resume` replays the journal and continues, with an optional reply for the pending gate.

```
$ wa list workflows
fix  --bug <text>
  reproduce a bug, fix it against the repo checks, then the pull request

ticket  --ticket <text>
  ticket to merged PR: triage, plan, implement, review, then the pull request
```

A param prints as `--name <text>`, a boolean as `--name`, and an enum as `--name <one|two>`. Brackets mark an optional param. A long description wraps to the width of the terminal.

## The ctx API

- `ctx.params`: the validated params.
- `ctx.agent({use, cwd})`: open an agent session. The handle is one conversation: `session.run(skill, {input, result})` is one turn, and the engine validates the result against the schema. A fresh handle is a fresh conversation.
- `ctx.vcs`, `ctx.github`, and any role you add: the installed adapters, typed in your editor through the generated `wa-env.d.ts`. Every method call is a journaled step.
- `ctx.view`: typed output. `activity` wraps a span, `fact` sets what is true now, `event` appends to the scroll, `artifact` names a thing to open, `watch` declares live numbers the view samples.
- `ctx.gate(question)`: ask a question and wait for the answer.

Every await on a journaled call is a durable checkpoint. Control flow, batching, and parallelism are plain TypeScript.

## Adapters

An adapter is one TypeScript file: a role (its `ctx` key), a name, and a build function that returns its methods. The shell lives only there: adapter authors get `host.shell` and `host.exec`, workflows do not. Put a file in `<repo>/.wa/adapters/` or `~/.wa/adapters/` to add or replace one. Swapping git for jj means one file that declares the same role.

## Keep the run replayable

1. Send all IO through journaled ctx calls. Read no clock, no randomness, no environment, no files.
2. Hold no module-level mutable state.
3. Keep the code between two awaits fast and free of side effects.

View calls are exempt: they are output, and replay never repeats them.

## Where the state lives

`~/.wa/` holds your workflow files, `adapters/`, `skills/`, `defaults`, and `runs/`. `~/.wa/runs/<run>/` holds `journal.jsonl`, `events.jsonl`, the pinned copy of the workflow file, the session transcripts, and the lock. To discard a run, delete the directory. Set `WA_HOME` to move the whole tree.

`<repo>/.wa/` holds the workflow files, skills, and adapters of one repository, and ships in git.

## Specs

`.specs/` is the source of truth for the design.
