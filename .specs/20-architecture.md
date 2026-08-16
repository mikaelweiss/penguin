# Architecture

## Components

- **CLI (TypeScript)**: one npm package, one `wa` command, the whole engine: command parsing, journal, replay, step dispatch, adapter loading, the event bus. It runs on system Node (24 or newer), one foreground process per executing run. Each `wa run` or `wa resume` executes exactly one run in the foreground.
- **Workflow and adapter loading**: wa imports the files directly. Node strips the types on import. A ctx call is a direct function call into the engine, which journals the call and its result. Replay re-executes the file while the journal answers each call in sequence, until execution reaches the first unanswered call and goes live.
- **wa package (TypeScript)**: the functions authors import (`workflow`, `adapter`) and their types, part of wa itself, with zod as a bundled dependency. The catalog ships a `tsconfig.json` that maps `wa` and `zod` to the installed package (`30-defaults.md`), so the author's editor resolves the same types. The user's repo needs no npm install.

## Storage

Plain files.

- `~/.wa/*.ts`: the personal workflow files.
- `~/.wa/adapters/*.ts`: the personal adapter files. Install copies the shipped ones here.
- `~/.wa/skills/`: the skills every workflow can name. A skill directly inside it is wa's own. A symlink inside it points at a whole skill directory the user already keeps, and `.order` holds those link names, most preferred first.
- `~/.wa/defaults`: one line per role, `<role> <name>`, choosing among installed implementations. Only a role with more than one implementation needs a line.
- `~/.wa/wa-env.d.ts`: generated. It types `ctx` from the installed adapters, so workflow files autocomplete with zero imports. wa rewrites it on install, on every `wa run`, and on `wa list adapters`. A stale copy misleads the editor only: the engine resolves adapters when it runs.
- `~/.wa/runs/<name>/`: one flat directory per run, the run name as the directory name. `journal.jsonl` (append-only; entry zero records the params, the workflow file path, the invoking folder, and the creation time), `workflow.ts` (the pinned source copy), `events.jsonl` (every emitted event, append-only), `transcripts/` (one file per agent session), `lock` (held by the executing process).
- `<project>/.wa/`: the same definition places for one repository: `*.ts`, `adapters/`, and `skills/`. It ships in git. It holds no runs.

`WA_HOME` moves the whole tree.

The first wa command installs (commands below). A home that exists is left alone.

Run state derives from the files: a held lock means running, a journal that ends at an unanswered gate or a recorded interruption means parked, a journal that records the run function's return means done.

## Adapters

An adapter is one TypeScript file that default-exports `adapter({role, name, description, build})`. `role` is the key it takes on `ctx`. `name` is which implementation it is. `build(host)` returns the role's API: an object of methods, nested objects allowed.

`host` is the engine's hand to adapter authors, and the only place shell access lives: `host.cwd` (the run's invoking folder), `host.shell(cmd, {cwd, stdin})`, `host.exec(argv, {cwd, stdin, onOutput})` for streaming, and `host.emit(event)`. Workflows have no shell. Anything no adapter covers is impossible until someone writes the adapter, which is the point.

The engine journals every adapter method call by itself: step id, role plus method plus arguments as the key, the return value as the result. Adapter authors never journal by hand, and return values are plain JSON data. Processes an adapter starts through `host` die when the run parks.

**Discovery** is the skills rule: `<project>/.wa/adapters/*.ts` is local and ships in git, `~/.wa/adapters/*.ts` is personal, and local wins when both hold the same role and name. **Selection** within a role: a session's `use` option first, then the `defaults` file, then the only implementation installed. More than one implementation with no default parks the run and names the fix.

Two roles the engine treats specially:

- **agent**: `build(host)` returns `{turn(turn)}`. The engine owns sessions, skill resolution, prompt assembly, schema validation, and the retry rule. The adapter owns the CLI invocation and the result transport. Each turn receives the session id, whether the session has had a turn before, the cwd, the prompt, the JSON schema when a result is wanted, and the session options. The claude adapter runs `claude -p` with `--session-id` on the first turn and `--resume` after, reads stream-json into typed agent events, and takes results from `--json-schema` structured output.
- **view**: `build(host)` returns `{render(event)}`. Render calls are never journaled. The terminal adapter prints events as lines and, on a TTY, keeps a live footer: the watch samples and the latest facts. With no view adapter installed the engine prints plain lines itself.

## Events

Every step, gate, and view call becomes one typed event: run started and ended, step started and ended with its activity, activity spans, facts, workflow events, artifacts, watch declarations, agent output, gates asked and answered. The engine appends each one to `events.jsonl` and hands it to the view adapter. An out-of-process UI tails the file: no port, no daemon, and it works after the run ends.

Replay emits nothing. When the run goes live, the bus first re-announces the activities still open, the latest watch, and the merged facts, then streams normally. The engine attributes each step to the activity that contains it, so a renderer can show structure and attribute time.

## Agent sessions

Opening a session journals a generated session id, so replay hands back the same conversation and a resumed run continues it. A turn is one journaled step keyed by session, skill, and input. The transcript of a session is one file under `transcripts/`, named by the session id: the engine appends each prompt, and the adapter's agent events append as they stream. A schema mismatch goes back into the same conversation as a correction turn, once, then gates. The agent CLI keeps its own session state outside `~/.wa`, so deleting a run directory deletes wa's record of the conversation, not the CLI's.

A run interrupted mid-turn re-dispatches the turn on resume (invariant 4), and the conversation then holds the interrupted attempt too. That is accepted: cleaner interrupt handling arrives with inbound messages.

## Run lifecycle

`wa run <file> [params]` validates params, creates the run, and executes it in the foreground. Before the first step it prints one line: the run name, that the run started, and the default agent adapter's name, or that no agent adapter is installed. Each turn spawns the agent CLI through its adapter, which streams typed events while the engine writes the transcript. The engine validates each result against the turn's schema (the retry rule is in `10-workflow-model.md`).

A gate prompts in the terminal. When the process has no terminal (cron) or the user gives no answer, the run parks: the process exits, and the question stays recorded in the journal.

Ctrl-C, process death, and an uncaught error from the run function park the run with the reason recorded. The journal keeps every completed step. A park stops the steps still in flight, and they re-dispatch on resume. A run that parks at a gate exits zero. A run that parks on an error exits one, which is what cron reads.

`wa resume <run> [reply]` replays the journal and continues in the foreground. With no reply, a pending gate prompts again. With a reply, wa journals it as the gate's answer and continues. A run parked mid-step re-dispatches from the step boundary.

To discard a run, delete its directory.

A lock file makes execution exclusive: a second wa process on the same run fails plainly with the holder's pid. A lock whose process is gone is taken over.

OS cron calling `wa` covers schedules.

## Skills

A skill is a directory that holds a `SKILL.md`, in the [Agent Skills](https://agentskills.io) format: frontmatter with `name` (the directory name) and `description`, then the craft in markdown. One markdown file named for the skill works too. wa sends the file content with the turn prompt.

wa links a whole skill directory, never one skill: a skill the user adds later shows up with no second command. The two sources are `.claude/skills/` and `.agents/skills/`. A link keeps its source's short name, `claude` or `agents`.

`wa sync-skills` writes those links. On a terminal it asks which directories to use. When both hold a skill of the same name it asks which directory is the preference, and writes the answer to `.order`. With no terminal it takes every directory that exists, `claude` first. `--global` reads the two directories under the home folder and writes `~/.wa/skills/`. `--local` reads the two under the invoking folder and writes `<project>/.wa/skills/`. With no option it does both.

Sync writes symlinks and `.order`, nothing else. A skill the user wrote into the target survives every sync, and a link to a directory that is gone disappears.

`wa sync-skills` prints the links it wrote. Install syncs silently.

A turn's skill name resolves against an ordered list of roots: the project skills directory, then its links in `.order` order, then the home skills directory, then its links. The first root that holds the name wins. wa's own skills carry a `wa-` prefix, so they never take the name of a skill the user already has.

## Commands

`install`, `list`, `run`, `ps`, `resume`, `sync-skills`, and no command.

- `install`: draw the wa wordmark, create `~/.wa/` and `~/.wa/runs/`, copy the catalog (`30-defaults.md`) into `~/.wa/`, write `wa-env.d.ts`, then sync the global skills (skills above). The first wa command runs it.
- `list`: what wa can use, as one block per entry. The first line is the name, then the params a workflow takes. The next lines are the description, indented two spaces and wrapped to the terminal width. `--verbose` adds a last line: scope and file, and for skills, source. A param prints as `--name <text>`, a boolean as `--name`, an enum as `--name <one|two>`, and an optional param in brackets. `list workflows` is the workflow files: `<project>/.wa/*.ts` is local, `~/.wa/*.ts` is global. The description and the params are the workflow export. `list skills` is the skills a turn can name, in resolution order, one block per name. The description is the skill frontmatter. `list adapters` is the installed adapters: the first line is the role and the implementation name, then the description. It also rewrites `wa-env.d.ts`. The verbose file line prints the real path, through any symlink. A bare `list` fails and names the three targets.
- `run`: validate params + create + execute, after the start line (run lifecycle above). It takes a workflow name from the list, local before global, or a path to any workflow file. With no workflow it lists them (the same blocks, plus the one line that runs one). It rewrites `wa-env.d.ts` first.
- `ps`: a plain table of the runs: run, workflow file, state, current step or pending gate question, age, run directory. Transcripts are files in that directory: read them with any tool.
- `resume`: replay + continue, with an optional reply for the pending gate (run lifecycle above).
- `sync-skills`: choose the skill directories again (skills above).
- no command: the usage text. When this command is the first wa command, the install output is the whole output.

Every question is a keyboard list: arrows move, space toggles a choice, enter confirms. On confirm wa erases the question. With no terminal wa takes the default answer. Nothing waits for input that cannot arrive.

## Invariants

Each one line, each pinned by a test:

1. A run keeps a pinned copy of its workflow file, and replay executes the copy. Editing a definition never changes an existing run.
2. The journal is append-only. Replay of the pinned copy against its journal reaches the same live point with zero re-executed side effects.
3. At most one process executes a run at a time. A second `wa` process on the same run fails plainly with the holder's pid.
4. A run interrupted mid-step resumes from the step boundary. Completed steps never re-execute.
5. A gate consumes exactly one answer, and the answer is journaled.
6. Replay verifies every call against the journal. A call that does not match its journal entry parks the run before any side effect runs.
7. The engine depends on no adapter and no definition. The engine test suite passes with an empty `~/.wa/`, and a workflow that names a missing role or agent parks plainly.
8. The first wa command installs. Sync links whole directories, and never removes a skill the user put in the target.
9. A skill name resolves from the project roots before the home roots, and from the preferred link before the other. A skill path resolves against the workflow file. An adapter resolves from the project before the home.
10. A session keeps its id across park and resume: replay hands back the same conversation, and only a new handle opens a new one.
11. View calls never enter the journal, and replay never re-emits an already-delivered event.
