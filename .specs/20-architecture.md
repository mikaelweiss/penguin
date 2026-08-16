# Architecture

## Components

- **CLI (TypeScript)**: one npm package, one `wa` command, the whole engine: command parsing, journal, replay, step dispatch, agent spawning, output rendering. It runs on system Node (24 or newer), one foreground process per executing run. Each `wa run` or `wa resume` executes exactly one run in the foreground.
- **Workflow loading**: wa imports the workflow file directly. Node strips the types on import. A step API call is a direct function call into the engine, which journals the call and its result. Replay re-executes the file while the journal answers each call in sequence, until execution reaches the first unanswered call and goes live.
- **wa package (TypeScript)**: the types workflow authors import (`workflow`), part of wa itself, with zod as a bundled dependency. The catalog ships a `tsconfig.json` that maps `wa` and `zod` to the installed package (`30-defaults.md`), so the author's editor resolves the same types. The user's repo needs no npm install.

## Storage

Plain files.

- `~/.wa/runs/<name>/`: one flat directory per run, the run name as the directory name. `journal.jsonl` (append-only; entry zero records the params, the workflow file path, the invoking folder, and the creation time), `workflow.ts` (the pinned source copy), `transcripts/` (one file per agent invocation), `artifacts/`, `lock` (held by the executing process).
- `~/.wa/agent`: one line, the default agent command.

Run state derives from the files: a held lock means running, a journal that ends at an unanswered gate or a recorded interruption means parked, a journal that records the run function's return means done.

## Run lifecycle

`wa run <file> [params]` validates params, creates the run, and executes it in the foreground. Each agent step spawns the agent command, writes the step prompt (input, skill content, result path) to its stdin, and pipes its output unchanged to the terminal and the transcript. The step ends when the agent writes `result.json` to the path the prompt supplies. The engine validates it against the step's schema (the retry rule is in `10-workflow-model.md`).

A gate prompts in the terminal. When the process has no terminal (cron) or the user gives no answer, the run parks: the process exits, and the question stays recorded in the journal.

Ctrl-C, process death, and an uncaught error from the run function park the run with the reason recorded. The journal keeps every completed step.

`wa resume <run> [reply]` replays the journal and continues in the foreground. With no reply, a pending gate prompts again. With a reply, wa journals it as the gate's answer and continues. When the gate has options, a reply outside them is rejected and the gate stays pending. A run parked mid-step re-dispatches from the step boundary.

To discard a run, delete its directory.

A lock file makes execution exclusive: a second wa process on the same run fails plainly with the holder's pid.

OS cron calling `wa` covers schedules.

## Agents

An agent is one shell command string, for example `claude -p`. wa spawns the string through the shell, writes the step prompt to its stdin, pipes its output unchanged to the terminal and the transcript, and validates `result.json`. The agent renders itself. The default string lives in `~/.wa/agent`. A step's `agent` option overrides it. An agent step with no agent configured parks the run, with the one line to write to `~/.wa/agent` as the recorded reason.

## Commands

`run`, `resume`, `list`.

- `run`: validate params + create + execute (run lifecycle above).
- `resume`: replay + continue, with an optional reply for the pending gate (run lifecycle above).
- `list`: a plain table: run, workflow file, state, current step or pending gate question, age, run directory. Transcripts and artifacts are files in that directory: read them with any tool.

## Invariants

Each one line, each pinned by a test:

1. A run keeps a pinned copy of its workflow file, and replay executes the copy. Editing a definition never changes an existing run.
2. The journal is append-only. Replay of the pinned copy against its journal reaches the same live point with zero re-executed side effects.
3. At most one process executes a run at a time. A second `wa` process on the same run fails plainly with the holder's pid.
4. A run interrupted mid-step resumes from the step boundary. Completed steps never re-execute.
5. A gate consumes exactly one answer, and the answer is journaled. An invalid reply leaves the gate pending.
6. Replay verifies every call against the journal. A call that does not match its journal entry parks the run before any side effect runs.
7. The engine depends on no agent and no definition. The engine test suite passes with an empty `~/.wa/`.
