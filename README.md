# penguin

penguin runs one workflow as a live process, against any repository, with any coding agent CLI.

A workflow is one TypeScript file: a params schema and a run function over `ctx`. The run is its own process: it keeps going with no terminal open. The terminal is a viewer that attaches, watches, sends messages, and detaches.

## Install

```sh
bun install -g @mikaelweiss/penguin
```

penguin needs Bun 1.3 or newer, and it runs on Bun only. Your repository needs no install of its own.

The first penguin command sets up `~/.penguin/` and enables the starter catalog. It does not copy workflows into the home:

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

Install enables the starter catalog (`examples/` in the penguin package) and writes a `defaults` file that picks the agent, plus a tsconfig for editor types. `pn list workflows` shows those workflows. A name says what a workflow is. A pipeline is a compound or an outcome, and you start it:

- `pn run ship --ticket ABC-123`: ticket to open PR: triage splits the ticket into tasks, then plan and implement per task in a worktree, then the pull request.
- `pn run ship-local --ticket "the footer scrolls"`: the same work, landed instead of proposed. It commits, holds until you answer done, then rebases onto main and moves main to it.
- `pn run review-pr --pr 42`: review an open PR. A change small enough to read yourself holds at a gate first. Then post the findings, approve when nothing blocks, and review again on every push until it closes.
- `pn run pr-queue`: watch this repository for the pull requests that ask for your review, and run review-pr on each one as it arrives.
- `pn run make-workflow --idea "..."`: design, write, and review a new workflow.

A step is one bare verb. Each one runs alone, and the pipelines call them:

- `pn run work --ticket ABC-123`: triage, then plan and implement each task in a worktree. The middle of both pipelines.
- `pn run triage --ticket ABC-123`: is the ticket ready to work on, why, and the tasks that build it.
- `pn run plan --ticket ABC-123`: the plan and its acceptance checks: questions gate first, then an approve-or-revise gate.
- `pn run implement --task "..."`: implement in the current repository, review each round, up to `--rounds`.
- `pn run review --acceptance acceptance.md`: one review of the working tree against the checks.
- `pn run commit`: the agent writes the message, penguin stages and commits.
- `pn run land --branch penguin-ABC-1`: rebase the branch onto main until it is clean, with an agent on each conflict, then fast-forward main to it.
- `pn run open-pr`: open the pull request, then a gate loop that runs address-feedback until you answer done.

The pipelines are the steps called as functions (Compose workflows, below).

`~/.penguin/adapters/` holds the adapters: `claude`, `codex`, `cursor`, `opencode`, and `pi` (the agents), `git`, `gh`, and `jira`. `~/.penguin/defaults` picks one implementation per role, and it ships with one line, `agent claude`. Every catalog entry is an ordinary file after the copy: edit, delete, or replace it freely.

Workflow files live in `~/.penguin/` for every repository, or in `<repo>/.penguin/` for one. Skills and adapters live next to them, in `skills/` and `adapters/`.

## Write a workflow

```typescript
import { workflow } from "penguin";
import { z } from "zod";

const Ack = z.union([z.enum(["ok"]), z.string()]);
const Triage = z.object({ actionable: z.boolean(), reason: z.string(), tasks: z.array(z.string()) });

export default workflow({
  description: "ticket to open pull request",
  params: z.object({ ticket: z.string() }),

  async run({ params, agent, github, gate }) {
    const t = (await agent().run("penguin-triage", { input: params.ticket, result: Triage }))!;
    if (!t.actionable) {
      await gate(`Not actionable: ${t.reason}`, Ack);
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
pn run ship --ticket ABC-123      # by name, or by path: pn run ./ship.ts
pn run ship --ticket ABC-123 --background
pn ps                             # the live runs
pn attach ship-1                  # watch one again
```

`list` is how you see what penguin has. Each entry is a block: the name and the params it takes, then the description under it. `--verbose` adds a line for where the entry comes from. `run` validates the params against the schema, creates the run, starts the run process, and attaches your terminal to it. With no workflow it lists them. It opens with one line, the run name and the agent it uses:

```
$ pn run implement --task "rename the flag"
run implement-1 started, agent claude
```

`--background` starts the run and gives the terminal back. Bare `pn` opens the dashboard: the live runs with their state, and a needs-you list of every open question across them. Enter opens the run under the cursor, and entering from the needs-you list lands on the question. `y` copies the directory of the line under the cursor, and a line with several directories draws a list to pick one. `d` reveals a done section under the live runs, every run that ended with how it ended, and enter opens one read-only. `n` opens the workflow launcher: it lists every workflow, asks for the params it needs, and opens the new run's view. `ps` opens the same dashboard, or prints a plain table when piped. `attach` joins a run by name: it renders the whole history first, then follows the live events, so a late viewer sees what an early one saw.

```
$ pn list workflows
implement  --task <text> [--acceptance <text>] [--dir <text>] [--rounds <number>]
  implement a change and close the review findings

ship  --ticket <text> [--rounds <number>]
  ticket to open pull request: triage splits the ticket, then plan and implement
  per task in a worktree, then the pull request
```

A param prints as `--name <text>`, a boolean as `--name`, and an enum as `--name <one|two>`. Brackets mark an optional param. A long description wraps to the width of the terminal.

## The ctx API

- `ctx.params`: the validated params.
- `ctx.agent({use, cwd, name})`: open an agent session. The handle is one conversation: `session.run(skill, {input, result})` is one turn, and the engine validates the result against the schema. A `blocked` schema beside `result` makes the turn resolve to `{result}` or `{blocked}`: the agent fills exactly one, which is how an agent hands questions back for the workflow to gate. A fresh handle is a fresh conversation. `turn.stop()` kills the agent process and keeps the partial work, and the next turn on the same handle continues the conversation.
- `ctx.vcs`, `ctx.github`, `ctx.jira`, and any role you add: the installed adapters, typed in your editor through the generated `penguin-env.d.ts`. Every method call is one step in the view.
- `ctx.view`: typed output. `activity` wraps a span, `fact` sets what is true now, `event` appends to the scroll, `artifact` names a thing to open, `watch` declares live numbers the view samples.
- `ctx.gate(question, shape?)`: ask a question and wait for the answer. The answer is the next message you send. With a zod shape (`z.number()`, `z.enum([...])`, `z.array(z.enum([...]))`, `z.boolean()`) the gate returns that type, the terminal draws a list for it, and an answer that does not fit gets the question again. `z.union([z.enum([...]), z.string()])` names the options and takes any other text, so the terminal draws the list and the gate returns a string.
- `ctx.messages.next()`: the next message sent into the run, as `{text, session}`. Race it against a turn to interrupt an agent, or read it between turns.

Control flow, batching, and parallelism are plain TypeScript. `Promise.all` fans out, `Promise.race` takes the first.

## Adapters

An adapter is one TypeScript file: a role (its `ctx` key), a name, and a build function that returns its methods. The shell lives only there: adapter authors get `host.shell` and `host.exec`, workflows do not. Put a file in `<repo>/.penguin/adapters/` or `~/.penguin/adapters/` to add or replace one. Swapping git for jj means one file that declares the same role.

### Keys an adapter needs

An adapter that talks to an API asks for its key with `host.credential`:

```typescript
const creds = await host.credential({
  name: "jira",
  label: "Jira",
  url: "https://id.atlassian.com/manage-profile/security/api-tokens",
  fields: [
    { name: "site", label: "Your Jira site, like acme.atlassian.net", env: "JIRA_SITE" },
    { name: "email", label: "The email you sign in to Atlassian with", env: "JIRA_EMAIL" },
    { name: "token", label: "An API token from the link above", env: "JIRA_API_TOKEN", secret: true },
  ],
});
```

The first time a workflow reaches that call, the run blocks and your terminal shows the link that makes the key, then takes one field at a time. A secret field echoes stars. The terminal writes the values to `~/.local/state/penguin/credentials/jira.json`, mode 0600, and tells the run only that the file now holds them, so nothing lands in `events.jsonl` or `inbox.jsonl`. Every run after that finds them and asks nothing.

An environment variable wins over the stored file, which is how a server or a cron job supplies the same values. `rejected: "<why>"` says the provider refused what penguin had: your terminal shows the reason and four fixes, try again, type every value again, open the file in your editor, or stop the run, and the adapter calls again with whatever you leave behind. The `jira` adapter does that whenever your site answers 401, 403, or 404.

Workflow code writes none of this. `ctx.jira.issue.get("ABC-123")` is the whole story.

### What only you can fix

Some failures are nobody's to solve but yours: a CLI that is signed out, a tool that is not installed, a branch the remote does not have. `host.gate` hands the fix over and runs the call again:

```typescript
const Ready = z.union([z.enum(["done", "skip"]), z.string()]);

async function gh(cmd: string): Promise<CommandResult> {
  for (;;) {
    const done = await host.shell(cmd);
    const fix = blocking(done);
    if (fix === undefined) return done;
    if ((await host.gate(fix, Ready)) === "skip") return done;
  }
}
```

The run blocks with the line the adapter wrote, your terminal draws `done` and `skip`, and `done` runs the same command over. `skip` hands the failure back to the workflow. The `gh` adapter asks for gh absent, gh signed out, a checkout with no remote, and a branch that is not pushed. A workflow that calls `ctx.github.pr.create()` sees none of it.

## Watch a run

A run is in one of four states. **running**: a step is executing. **blocked**: the run waits on you, at a gate or at `ctx.messages.next()`. **idle**: the run waits on the outside world. **done**: the run function returned, you stopped it, or an error ended it. Done is final. To act again, start a new run.

In a run view, the run's tree fills the left pane: each activity, session, and sub-workflow call, with a glyph for its state. The right pane shows the transcript of whatever you select. The input bar sits under the transcript, at the same width, and names its target:

- Select an open gate and the bar takes your answer, addressed to that gate, so ten parallel questions never collide. An enum gate draws a list instead.
- Select a session and the bar sends to it.
- Select anything else and the bar sends to the run. When the run is not blocked, the bar says the message queues.
- The view opens with the tree focused. `esc` moves focus to the input bar, where every key you type goes to the bar and `ctrl-u` empties the draft. Enter sends and hands the keyboard back to the tree. Enter on an empty draft sends nothing and keeps the keyboard in the bar.
- With the tree focused, arrows move the selection and left and right fold a node. The pane scrolls to keep your selection in view. `esc` returns you to the bar. `q` goes to the dashboard.
- With the tree focused, `y` copies the directory the selected node runs in. A node with several directories draws a list to pick one.
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

`~/.penguin/` holds your workflow files, `adapters/`, `skills/`, `helpers/`, and `defaults`. Runs and credentials live under the state root `~/.local/state/penguin/`, so refreshing the catalog leaves them in place. `~/.local/state/penguin/runs/<run>/` holds `run.json`, `events.jsonl`, `inbox.jsonl`, the session transcripts, and the lock. Every event the run emits appends to `events.jsonl`, so any other program tails the same file. To discard a run, delete the directory. Set `PENGUIN_HOME` to move the catalog and `XDG_STATE_HOME` to move the state.

`<repo>/.penguin/` holds the workflow files, skills, and adapters of one repository, and ships in git.

## Specs

`.specs/` is the source of truth for the design.

## License

Apache License 2.0. See [LICENSE](LICENSE).
