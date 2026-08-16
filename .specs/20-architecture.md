# Architecture

## Components

- **CLI (TypeScript)**: one npm package, one `wa` command, the whole engine: command parsing, journal, replay, step dispatch, agent spawning, output rendering. It runs on system Node (24 or newer), one foreground process per executing run. Each `wa run` or `wa resume` executes exactly one run in the foreground.
- **Workflow loading**: wa imports the workflow file directly. Node strips the types on import. A step API call is a direct function call into the engine, which journals the call and its result. Replay re-executes the file while the journal answers each call in sequence, until execution reaches the first unanswered call and goes live.
- **wa package (TypeScript)**: the types workflow authors import (`workflow`), part of wa itself, with zod as a bundled dependency. The catalog ships a `tsconfig.json` that maps `wa` and `zod` to the installed package (`30-defaults.md`), so the author's editor resolves the same types. The user's repo needs no npm install.

## Storage

Plain files.

- `~/.wa/*.ts`: the personal workflow files.
- `~/.wa/skills/`: the skills every workflow can name. A skill directly inside it is wa's own. A symlink inside it points at a whole skill directory the user already keeps, and `.order` holds those link names, most preferred first.
- `~/.wa/runs/<name>/`: one flat directory per run, the run name as the directory name. `journal.jsonl` (append-only; entry zero records the params, the workflow file path, the invoking folder, and the creation time), `workflow.ts` (the pinned source copy), `transcripts/` (one file per agent invocation), `lock` (held by the executing process).
- `~/.wa/agent`: one line, the default agent command.
- `<project>/.wa/`: the same two definition places for one repository, `*.ts` and `skills/`. It ships in git. It holds no runs.

`WA_HOME` moves the whole tree.

The first wa command installs (commands below). A home that exists is left alone.

Run state derives from the files: a held lock means running, a journal that ends at an unanswered gate or a recorded interruption means parked, a journal that records the run function's return means done.

## Run lifecycle

`wa run <file> [params]` validates params, creates the run, and executes it in the foreground. Each agent step spawns the agent command, writes the step prompt (input, skill content, result path) to its stdin, and pipes its output unchanged to the terminal and the transcript. The step ends when the agent writes `result.json` to the path the prompt supplies. The engine validates it against the step's schema (the retry rule is in `10-workflow-model.md`).

A gate prompts in the terminal. When the process has no terminal (cron) or the user gives no answer, the run parks: the process exits, and the question stays recorded in the journal.

Ctrl-C, process death, and an uncaught error from the run function park the run with the reason recorded. The journal keeps every completed step. A park stops the steps still in flight, and they re-dispatch on resume. A run that parks at a gate exits zero. A run that parks on an error exits one, which is what cron reads.

`wa resume <run> [reply]` replays the journal and continues in the foreground. With no reply, a pending gate prompts again. With a reply, wa journals it as the gate's answer and continues. A run parked mid-step re-dispatches from the step boundary.

To discard a run, delete its directory.

A lock file makes execution exclusive: a second wa process on the same run fails plainly with the holder's pid. A lock whose process is gone is taken over.

OS cron calling `wa` covers schedules.

## Agents

An agent is one shell command string, for example `claude -p`. wa spawns the string through the shell, writes the step prompt to its stdin, pipes its output unchanged to the terminal and the transcript, and validates `result.json`. The agent renders itself. The default string lives in `~/.wa/agent`. A step's `agent` option overrides it. An agent step with no agent configured parks the run, with the one line to write to `~/.wa/agent` as the recorded reason.

## Skills

A skill is a directory that holds a `SKILL.md`, in the [Agent Skills](https://agentskills.io) format: frontmatter with `name` (the directory name) and `description`, then the craft in markdown. One markdown file named for the skill works too. wa sends the file content with the step prompt.

wa links a whole skill directory, never one skill: a skill the user adds later shows up with no second command. The two sources are `.claude/skills/` and `.agents/skills/`. A link keeps its source's short name, `claude` or `agents`.

`wa sync-skills` writes those links. On a terminal it asks which directories to use. When both hold a skill of the same name it asks which directory is the preference, and writes the answer to `.order`. With no terminal it takes every directory that exists, `claude` first. `--global` reads the two directories under the home folder and writes `~/.wa/skills/`. `--local` reads the two under the invoking folder and writes `<project>/.wa/skills/`. With no option it does both.

Sync writes symlinks and `.order`, nothing else. A skill the user wrote into the target survives every sync, and a link to a directory that is gone disappears.

`wa sync-skills` prints the links it wrote. Install syncs silently.

A step's skill name resolves against an ordered list of roots: the project skills directory, then its links in `.order` order, then the home skills directory, then its links. The first root that holds the name wins. wa's own skills carry a `wa-` prefix, so they never take the name of a skill the user already has.

## Commands

`install`, `list`, `run`, `ps`, `resume`, `sync-skills`, and no command.

- `install`: draw the wa wordmark, create `~/.wa/` and `~/.wa/runs/`, copy the catalog (`30-defaults.md`) into `~/.wa/`, then sync the global skills (skills above). The first wa command runs it.
- `list`: what wa can use. `list workflows` is a plain table of the workflow files: name, scope, file. `<project>/.wa/*.ts` is local, `~/.wa/*.ts` is global. `list skills` is a plain table of the skills a step can name: name, scope, source, file, in resolution order, one row per name. Both tables print the real path, through any symlink. A bare `list` fails and names the two targets.
- `run`: validate params + create + execute (run lifecycle above). It takes a workflow name from the list, local before global, or a path to any workflow file. With no workflow it lists them.
- `ps`: a plain table of the runs: run, workflow file, state, current step or pending gate question, age, run directory. Transcripts are files in that directory: read them with any tool.
- `resume`: replay + continue, with an optional reply for the pending gate (run lifecycle above).
- `sync-skills`: choose the skill directories again (skills above).
- no command: the workflow table, plus the one line that runs one. When this command is the first wa command, the install output is the whole output.

Every question is a keyboard list: arrows move, space toggles a choice, enter confirms. On confirm wa erases the question. With no terminal wa takes the default answer. Nothing waits for input that cannot arrive.

## Invariants

Each one line, each pinned by a test:

1. A run keeps a pinned copy of its workflow file, and replay executes the copy. Editing a definition never changes an existing run.
2. The journal is append-only. Replay of the pinned copy against its journal reaches the same live point with zero re-executed side effects.
3. At most one process executes a run at a time. A second `wa` process on the same run fails plainly with the holder's pid.
4. A run interrupted mid-step resumes from the step boundary. Completed steps never re-execute.
5. A gate consumes exactly one answer, and the answer is journaled.
6. Replay verifies every call against the journal. A call that does not match its journal entry parks the run before any side effect runs.
7. The engine depends on no agent and no definition. The engine test suite passes with an empty `~/.wa/`.
8. The first wa command installs. Sync links whole directories, and never removes a skill the user put in the target.
9. A skill name resolves from the project roots before the home roots, and from the preferred link before the other. A skill path resolves against the workflow file.
