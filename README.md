# penguin

penguin runs one workflow as a live process, against any repository, with any coding agent CLI.

A workflow is one TypeScript file: a params schema and a run function over `ctx`. The run is its own process: it keeps going with no terminal open. The terminal is a viewer that attaches, watches, sends messages, and detaches.

## Install

```sh
npm install -g @mikaelweiss/penguin
```

penguin needs Node 24 or newer. Your repository needs no npm install.

The first penguin command sets up `~/.penguin/` and copies the starter catalog into it:

```
created ~/.penguin
run `pn list workflows` to see what's available and then `pn run <workflow>` from a project directory to get started
```

On a terminal it also asks which skill directories penguin should link, `~/.claude/skills` and `~/.agents/skills`. Arrows move, space toggles, enter confirms. When both hold a skill of the same name it asks which directory you prefer. penguin links the whole directory, so a skill you write next week is there already. Run `pn sync-skills` to choose again:

```sh
pn sync-skills --global   # ~/.claude/skills and ~/.agents/skills    -> ~/.penguin/skills
pn sync-skills --local    # <repo>/.claude/skills and .agents/skills -> <repo>/.penguin/skills
```

Sync writes symlinks and the `.order` file, nothing else. A skill you wrote into `~/.penguin/skills/` yourself stays, and it wins the name.

## The starter catalog

Install fills `~/.penguin/` with nine workflows, their skills, four adapters, and a tsconfig for editor types. Two of them are pipelines:

- `pn run ticket --ticket ABC-123`: ticket to merged PR: triage, plan, a worktree, implement, then the pull request.
- `pn run fix --bug "..."`: reproduce the bug, fix it in a loop your repository's own checks close, then the pull request.

The other seven are small workflows. Each one runs alone, and a pipeline calls all but `review-pr`:

- `pn run triage --ticket ABC-123`: is the ticket ready to work on, and why.
- `pn run plan --ticket ABC-123`: the plan and its acceptance checks, held at an approve-or-revise gate.
- `pn run implement --task "..."`: implement in the current repository, review each round, up to `--rounds`.
- `pn run review --acceptance acceptance.md`: one review of the working tree against the checks.
- `pn run verify`: run the checks of your repository and report what fails.
- `pn run pr`: open the pull request, then a gate loop that runs address-feedback until you answer done.
- `pn run review-pr --pr 42`: fetch the PR diff, review it into a findings file, then a gate that posts it as a PR comment.

A pipeline is the small ones called as functions (Compose workflows, below).

`~/.penguin/adapters/` holds the adapters: `claude` (the agent), `git`, `gh`, and `terminal`. Every catalog entry is an ordinary file after the copy: edit, delete, or replace it freely.

Workflow files live in `~/.penguin/` for every repository, or in `<repo>/.penguin/` for one. Skills and adapters live next to them, in `skills/` and `adapters/`.

## Write a workflow

```typescript
import { workflow } from "penguin";
import { z } from "zod";

const Triage = z.object({ actionable: z.boolean(), reason: z.string() });

export default workflow({
  description: "ticket to merged PR",
  params: z.object({ ticket: z.string() }),

  async run({ params, agent, github, gate }) {
    const t = (await agent().run("penguin-triage", { input: params.ticket, result: Triage }))!;
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
pn list workflows                 # name, params, and description
pn list skills --verbose          # plus scope, source, and file
pn list adapters                  # role, implementation, and description
pn run ticket --ticket ABC-123    # by name, or by path: pn run ./ticket.ts
pn run ticket --ticket ABC-123 --background
pn ps                             # the live runs
pn attach ticket-1                # watch one again
```

`list` is how you see what penguin has. Each entry is a block: the name and the params it takes, then the description under it. `--verbose` adds a line for where the entry comes from. `run` validates the params against the schema, creates the run, starts the run process, and attaches your terminal to it. With no workflow it lists them. It opens with one line, the run name and the agent it uses:

```
$ pn run implement --task "rename the flag"
run implement-1 started, agent claude
```

`--background` starts the run and gives the terminal back. `ps` lists the live runs: on a terminal it is a picker, and enter attaches to the run under the cursor. `attach` joins a run by name: it renders the whole history first, then follows the live events, so a late viewer sees what an early one saw. Bare `pn` prints the usage.

```
$ pn list workflows
fix  --bug <text> [--rounds <number>]
  reproduce a bug, fix it against the repo checks, then the pull request

ticket  --ticket <text>
  ticket to merged PR: triage, plan, implement, review, then the pull request
```

A param prints as `--name <text>`, a boolean as `--name`, and an enum as `--name <one|two>`. Brackets mark an optional param. A long description wraps to the width of the terminal.

## The ctx API

- `ctx.params`: the validated params.
- `ctx.agent({use, cwd, name})`: open an agent session. The handle is one conversation: `session.run(skill, {input, result})` is one turn, and the engine validates the result against the schema. A fresh handle is a fresh conversation. `turn.stop()` kills the agent process and keeps the partial work, and the next turn on the same handle continues the conversation.
- `ctx.vcs`, `ctx.github`, and any role you add: the installed adapters, typed in your editor through the generated `penguin-env.d.ts`. Every method call is one step in the view.
- `ctx.view`: typed output. `activity` wraps a span, `fact` sets what is true now, `event` appends to the scroll, `artifact` names a thing to open, `watch` declares live numbers the view samples.
- `ctx.gate(question, shape?)`: ask a question and wait for the answer. The answer is the next message you send. With a zod shape (`z.number()`, `z.enum([...])`, `z.array(z.enum([...]))`, `z.boolean()`) the gate returns that type, the terminal draws a list for it, and an answer that does not fit gets the question again.
- `ctx.messages.next()`: the next message sent into the run, as `{text, session}`. Race it against a turn to interrupt an agent, or read it between turns.

Control flow, batching, and parallelism are plain TypeScript. `Promise.all` fans out, `Promise.race` takes the first.

## Adapters

An adapter is one TypeScript file: a role (its `ctx` key), a name, and a build function that returns its methods. The shell lives only there: adapter authors get `host.shell` and `host.exec`, workflows do not. Put a file in `<repo>/.penguin/adapters/` or `~/.penguin/adapters/` to add or replace one. Swapping git for jj means one file that declares the same role.

## Watch a run

A run is in one of four states. **running**: a step is executing. **blocked**: the run waits on you, at a gate or at `ctx.messages.next()`. **idle**: the run waits on the outside world. **done**: the run function returned, you stopped it, or an error ended it. Done is final. To act again, start a new run.

In an attached terminal:

- Type a line and press enter to send a message. A gate takes it as the answer.
- `Tab` picks which session fills the screen, and addresses your next message to it.
- `q` detaches. The run keeps going, and `pn attach` comes back to it.
- `Ctrl-C` stops the run. penguin kills the steps in flight and records the stop.

Closing the terminal never touches the run.

## Compose workflows

A workflow calls another workflow as a function:

```typescript
import triage from "./triage.ts";

const t = await triage(ctx, { ticket: params.ticket });
```

The call validates the arguments against the callee's params schema, runs the callee on the same `ctx`, and returns what the callee returns. Only the root is a run, so `pn ps` shows one line. `run` may return a value: a caller receives it, and at the root `pn run` prints it.

## Where the state lives

`~/.penguin/` holds your workflow files, `adapters/`, `skills/`, `defaults`, and `runs/`. `~/.penguin/runs/<run>/` holds `run.json`, `events.jsonl`, `inbox.jsonl`, the session transcripts, and the lock. Every event the run emits appends to `events.jsonl`, so any other program tails the same file. To discard a run, delete the directory. Set `PENGUIN_HOME` to move the whole tree.

`<repo>/.penguin/` holds the workflow files, skills, and adapters of one repository, and ships in git.

## Specs

`.specs/` is the source of truth for the design.

## License

Apache License 2.0. See [LICENSE](LICENSE).
