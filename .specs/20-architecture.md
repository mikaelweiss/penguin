# Architecture

## Components

- **CLI (TypeScript)**: one npm package, one `pn` command, the whole engine: command parsing, step dispatch, adapter loading, the event bus. It runs on system Node (24 or newer).
- **Run process**: one detached process per run. It executes the run function, holds the lock, appends events and transcripts, and reads messages. It owns no terminal, and it outlives the terminal that started it.
- **Viewer**: the terminal side of a run. `pn run` attaches one on start, and `pn attach` joins one later. A viewer renders the event history, follows new events, and sends messages. Closing a viewer never touches the run.
- **Workflow and adapter loading**: penguin imports the files directly. Node strips the types on import. A workflow imports `penguin`, `zod`, other workflow files, and shared TypeScript files by relative path.
- **penguin package (TypeScript)**: the functions authors import (`workflow`, `adapter`) and their types, part of penguin itself, with zod as a bundled dependency. The catalog ships a `tsconfig.json` that maps `penguin` and `zod` to the installed package (`30-defaults.md`), so the author's editor resolves the same types. The user's repo needs no npm install.

## Storage

Plain files.

- `~/.penguin/*.ts`: the personal workflow files.
- `~/.penguin/adapters/*.ts`: the personal adapter files. Install copies the shipped ones here.
- `~/.penguin/skills/`: the skills every workflow can name. A skill directly inside it is penguin's own. A symlink inside it points at a whole skill directory the user already keeps, and `.order` holds those link names, most preferred first.
- `~/.penguin/defaults`: one line per role, `<role> <name>`, choosing among installed implementations. Only a role with more than one implementation needs a line.
- `~/.penguin/credentials/<name>.json`: one file per credential an adapter needs, mode 0600 inside a 0700 directory (credentials below).
- `~/.penguin/penguin-env.d.ts`: generated. It types `ctx` from the installed adapters, so workflow files autocomplete with zero imports. penguin rewrites it on install, on every `pn run`, and on `pn list adapters`. A stale copy misleads the editor only: the engine resolves adapters when it runs.
- `~/.penguin/runs/<name>/`: one flat directory per run, the run name as the directory name. `run.json` (the params, the workflow file path, the invoking folder, the creation time), `events.jsonl` (every emitted event, append-only), `inbox.jsonl` (every message sent in, append-only), `transcripts/` (one file per agent session), `lock` (held by the run process).
- `<project>/.penguin/`: the same definition places for one repository: `*.ts`, `adapters/`, and `skills/`. It ships in git. It holds no runs.

`PENGUIN_HOME` moves the whole tree.

The first penguin command installs (commands below). A home that exists is left alone.

Run state derives from the files and the process: a held lock is a live run, and the run's last state event says running, blocked, or idle. A lock whose process is gone is a done run, however it died.

## Adapters

An adapter is one TypeScript file that default-exports `adapter({role, name, description, build})`. `role` is the key it takes on `ctx`. `name` is which implementation it is. `build(host)` returns the role's API: an object of methods, nested objects allowed.

`host` is the engine's hand to adapter authors, and the only place shell access lives: `host.cwd` (the run's invoking folder), `host.shell(cmd, {cwd, stdin})`, `host.exec(argv, {cwd, stdin, onOutput})` for streaming, `host.wait(label, body)` for long waits, `host.emit(event)`, and `host.credential(request)` for the keys the adapter needs from the user (credentials below). Workflows have no shell and no keys. Anything no adapter covers is impossible until someone writes the adapter, which is the point.

The engine shows every adapter method call as one step in the view: role plus method, start and end. A method returns plain data, or a subscription: an object whose `next()` resolves on the next item. A method that waits on the outside world (a poll loop for new commits or tagged issues) wraps the wait in `host.wait(label, body)`: the run shows idle with the label while `body` runs. Processes an adapter starts through `host` die when the run ends.

**Discovery** is the skills rule: `<project>/.penguin/adapters/*.ts` is local and ships in git, `~/.penguin/adapters/*.ts` is personal, and local wins when both hold the same role and name. **Selection** within a role: a session's `use` option first, then the `defaults` file, then the only implementation installed. More than one implementation with no default fails the run and names the fix.

Two roles the engine treats specially:

- **agent**: `build(host)` returns `{turn(turn)}`. The engine owns sessions, skill resolution, prompt assembly, schema validation, and the retry rule. The adapter owns the CLI invocation and the result transport. Each turn receives the session id, whether the session has had a turn before, the cwd, the prompt, the JSON schema when a result is wanted, and the session options. When the workflow stops a turn, the engine kills the turn's process. The claude adapter runs `claude -p` with `--session-id` on the first turn and `--resume` after, reads stream-json into typed agent events, and takes results from `--json-schema` structured output.
- **view**: `build(host)` returns `{render(event)}`. The terminal adapter prints events as lines and, on a TTY, keeps a live footer: the watch samples, the latest facts, and one line per live session, named. With no view adapter installed the engine prints plain lines itself.

## Events

Every step, state change, question, message, and view call becomes one typed event: run started and ended, step started and ended with its activity, activity spans, facts, workflow events, artifacts, watch declarations, agent output by session, gates asked and answered, credentials asked and ready. A gate asked event carries the answer shape as a JSON schema when the gate has one. A credential event carries the fields by name, never a value. The engine appends each one to `events.jsonl` and hands it to the view adapter. A viewer renders the history from the file first, then follows live, so a viewer that joins late sees what a live one saw. An out-of-process UI tails the same file: no port, no daemon, and it works after the run ends.

## Messages

A message is one line sent into a run: `{text, session?}`. A viewer's input field appends it to `inbox.jsonl`, addressed to the run or to the session the viewer has selected. The run process delivers each message once, in order, to the earliest waiting reader (`ctx.gate` or `ctx.messages.next()`). A message no reader awaits waits in the file. Only the workflow gives a message meaning: it stops a turn, feeds a new turn, or sits in the queue (`10-workflow-model.md`, messages).

## Credentials

Some adapters need a key the user has to make: a Jira API token, and anything like it. The adapter asks for it with `host.credential({name, label, url, hint, fields, refresh})`, and the engine finds it. A workflow writes nothing, so control flow never mentions a key.

One field is one value. `name` is the key it is stored under and the key on the returned object, `label` is the line the human reads, `env` names an environment variable that supplies it instead, and `secret` marks a value that must never be shown. The engine takes each field from its environment variable first, then from the stored record. Whatever is still missing becomes one credential asked event carrying the label, the link, the hint, and only the missing fields. The run shows blocked with the label until it has them.

A viewer answers it. On a terminal it takes one field at a time, echoes a secret field as stars, and shows the link that makes the key. It writes the values to the store itself, then appends one notice to `inbox.jsonl`, `{"credential": "<name>"}`. The value is never a message, so it never reaches `events.jsonl`. The run reads the store again and goes on, and emits a credential ready event naming only where the values came from. With no terminal the ask prints the link and the environment variable names, and the run waits for a viewer that can ask.

The store is one file per credential, `~/.penguin/credentials/<name>.json`, mode 0600 inside a 0700 directory: the user reads it and nobody else does. A name is lowercase letters, digits, and dashes. An environment variable is never written to the store. `refresh: true` forgets the stored record and asks again, which is how an adapter answers a key the provider rejects.

## Agent sessions

Opening a session generates a session id. The transcript of a session is one file under `transcripts/`, named by the session id: the engine appends each prompt, and the adapter's agent events append as they stream. Each session carries a name for the viewer and for message addressing. A schema mismatch goes back into the same conversation as a correction turn, once, then gates. A stopped turn keeps its partial work in the conversation, and the next turn continues it. The agent CLI keeps its own session state outside `~/.penguin`, so deleting a run directory deletes penguin's record of the conversation, not the CLI's.

## Run lifecycle

`pn run <file> [params]` validates params, creates the run, starts the run process, and attaches a viewer. `--background` starts the run process and prints the run name. Before the first step the run announces one line: the run name, that the run started, and the default agent adapter's name, or that no agent adapter is installed.

A run is in one of four states:

- **running**: a step is executing.
- **blocked**: the run waits on a message from the user: a gate or a `ctx.messages.next()`.
- **idle**: the run waits on the outside world, inside `host.wait`.
- **done**: the run function returned, the user stopped it, an error ended it, or the process died. Done is final: nothing revives a run. To act again, start a new run.

When waits overlap, running beats blocked, and blocked beats idle. The run process emits a state event on every change.

In a viewer: typing into the input field sends a message, a key switches which session's stream fills the screen, `q` detaches, and Ctrl-C stops the run. A gate with a shape draws a control on a terminal, picked from the shape: a list for an enum, a checkbox list for an array of enum, yes or no for a boolean, and the input field with the expected type for anything else. The choice goes back as a message like any other, and an answer from elsewhere closes the control. The engine validates every answer against the shape, and asks the same question again until one fits. A stop kills the steps in flight, records the stop, and the run is done. Attaching to a done run renders the history read-only: no input field, because nothing can react.

An uncaught error from the run function ends the run with the error recorded. The run process exits zero when the run function returns and one on an error, which is what cron reads.

To discard a run, delete its directory.

A lock file makes execution exclusive: a second penguin process on the same run fails plainly with the holder's pid.

OS cron calling `pn run --background` covers schedules.

## Skills

A skill is a directory that holds a `SKILL.md`, in the [Agent Skills](https://agentskills.io) format: frontmatter with `name` (the directory name) and `description`, then the craft in markdown. One markdown file named for the skill works too. penguin sends the file content with the turn prompt.

penguin links a whole skill directory, never one skill: a skill the user adds later shows up with no second command. The two sources are `.claude/skills/` and `.agents/skills/`. A link keeps its source's short name, `claude` or `agents`.

`pn sync-skills` writes those links. On a terminal it asks which directories to use. When both hold a skill of the same name it asks which directory is the preference, and writes the answer to `.order`. With no terminal it takes every directory that exists, `claude` first. `--global` reads the two directories under the home folder and writes `~/.penguin/skills/`. `--local` reads the two under the invoking folder and writes `<project>/.penguin/skills/`. With no option it does both.

Sync writes symlinks and `.order`, nothing else. A skill the user wrote into the target survives every sync, and a link to a directory that is gone disappears.

`pn sync-skills` prints the links it wrote. Install syncs silently.

A turn's skill name resolves against an ordered list of roots: the project skills directory, then its links in `.order` order, then the home skills directory, then its links. The first root that holds the name wins. penguin's own skills carry a `penguin-` prefix, so they never take the name of a skill the user already has.

## Commands

`install`, `list`, `run`, `ps`, `attach`, `sync-skills`, and no command.

- `install`: draw the penguin wordmark, create `~/.penguin/` and `~/.penguin/runs/`, copy the catalog (`30-defaults.md`) into `~/.penguin/`, write `penguin-env.d.ts`, then sync the global skills (skills above). The first penguin command runs it.
- `list`: what penguin can use, as one block per entry. The first line is the name, then the params a workflow takes. The next lines are the description, indented two spaces and wrapped to the terminal width. `--verbose` adds a last line: scope and file, and for skills, source. A param prints as `--name <text>`, a boolean as `--name`, an enum as `--name <one|two>`, and an optional param in brackets. `list workflows` is the workflow files: `<project>/.penguin/*.ts` is local, `~/.penguin/*.ts` is global. The description and the params are the workflow export. `list skills` is the skills a turn can name, in resolution order, one block per name. The description is the skill frontmatter. `list adapters` is the installed adapters: the first line is the role and the implementation name, then the description. It also rewrites `penguin-env.d.ts`. The verbose file line prints the real path, through any symlink. A bare `list` fails and names the three targets.
- `run`: validate params + create + start + attach (run lifecycle above). It takes a workflow name from the list, local before global, or a path to any workflow file. With no workflow it lists them (the same blocks, plus the one line that runs one). It rewrites `penguin-env.d.ts` first.
- `ps`: the live runs. On a TTY it is a picker: arrows or hjkl move, enter attaches, `q` leaves. Piped, it is a plain table: run, workflow file, state, current step or pending question, age, run directory. Done runs never list: their directories stay on disk, and `pn attach` still opens them.
- `attach`: join a run by name: render the event history, then follow live with the input field. For a done run, the history alone.
- `sync-skills`: choose the skill directories again (skills above).
- no command: the usage text. When this command is the first penguin command, the install output is the whole output.

Every question penguin's own commands ask is a keyboard list: arrows move, space toggles a choice, enter confirms. On confirm penguin erases the question. With no terminal penguin takes the default answer. Nothing waits for input that cannot arrive.

## Invariants

Each one line, each pinned by a test:

1. At most one process executes a run. A second `pn` process on the same run fails plainly with the holder's pid.
2. Every event appends to `events.jsonl`, and a viewer that joins late renders the same story a live viewer saw.
3. `q` detaches and the run continues. Ctrl-C stops the run, and the stop is recorded.
4. Done is final: no command revives a done run, and attach to one is read-only.
5. The engine delivers each message at most once, in order, and each gate ask consumes exactly one message.
6. `turn.stop()` kills the agent process, and the session's next turn continues the same conversation.
7. A workflow call validates the callee's params before the callee runs, and a composed call creates no run.
8. The engine depends on no adapter and no definition. The engine test suite passes with an empty `~/.penguin/`, and a workflow that names a missing role or agent fails plainly.
9. The first penguin command installs. Sync links whole directories, and never removes a skill the user put in the target.
10. A skill name resolves from the project roots before the home roots, and from the preferred link before the other. A skill path resolves against the workflow file. An adapter resolves from the project before the home.
11. A gate with a shape validates the answer against it, and asks the same question again until an answer fits.
12. penguin never writes a credential value to `events.jsonl`, `inbox.jsonl`, or the screen. A viewer writes it to the store, and the run reads it from there.
