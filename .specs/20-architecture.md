# Architecture

## Components

- **CLI (TypeScript)**: one npm package, one `wa` command, the whole engine: command parsing, journal, replay, step dispatch, agent spawning, output rendering. It runs on system Node (20 or newer), one foreground process per executing run. No daemon, no socket, no database server. Each `wa run` or `wa resume` executes exactly one run in the foreground.
- **Workflow loading**: a workflow is one self-contained file, so there is no bundling. wa strips its types with esbuild's single-file `transform` (a library dependency) and evaluates the result in a sandboxed `node:vm` context. The context exposes standard JS builtins, the `wa` package, and zod, and nothing else: no `Date.now`, `Math.random`, `fetch`, `fs`, or timers, and no local imports. A step API call is a direct function call into the engine, which journals the call and its result. Replay re-executes the file while the journal answers each call in sequence, until execution reaches the first unanswered call and goes live.
- **wa package (TypeScript)**: the types workflow authors import (`workflow`), part of wa itself, with zod as a bundled dependency. `wa run` writes `.wa/tsconfig.json` when it is absent, mapping `wa` and `zod` to the installed wa package, so editor LSP and the `tsc` inside `wa run` resolve the same types. The user's repo needs no npm install.

The engine core defines no specific agent, workflow, or skill. What a fresh install ships is the catalog in `30-defaults.md`, and every entry is removable.

## Storage

Plain files, no database.

- `~/.wa/runs/<name>/`: one flat directory per run, the run name as the directory name. `run.json` (status, params, the invoking folder, timestamps), `journal.jsonl` (append-only), `workflow.ts` (the pinned source copy), `logs/` (engine log, one transcript per agent invocation), `artifacts/`, `lock` (held by the executing process).
- `~/.wa/config.toml`: agent entries (command templates), default agent, default model.
- `~/.wa/workflows/`, `~/.wa/skills/`: personal definitions. Install seeds them with the default set (`30-defaults.md`).

## Run lifecycle

`wa run <workflow> [params]` typechecks the workflow with `tsc`, validates params, creates the run, and executes it in the foreground. Each agent step spawns the agent CLI in print mode and pipes its output unchanged to the terminal and to the transcript log. The step ends when the agent writes `result.json` to the path wa supplies with the step prompt. The engine validates it against the step's schema (the retry rule is in `10-workflow-model.md`).

A gate prompts in the terminal. When the process has no terminal (cron) or the user does not answer, the run parks: the process exits, and the run waits on disk with the question recorded.

Ctrl-C parks the run: the in-flight step stops, the journal keeps every completed step, and resume re-dispatches from the step boundary.

`wa resume <run> [reply]` replays the journal and continues in the foreground. With no reply, a pending gate prompts again. With a reply, wa journals it as the gate's answer and continues. When the gate has options, a reply outside them is rejected and the gate stays pending.

To discard a run, delete its directory.

A lock file makes execution exclusive: a second wa process on the same run fails plainly with the holder's pid.

Schedules are not wa's job: OS cron calling `wa run` covers them.

## Agents

An agent is an entry in `config.toml`: the executable and how to pass a prompt and a model. wa builds the step prompt (input, skill content, result path), spawns the command, pipes its output unchanged to the terminal and the transcript log, and validates `result.json`. wa never parses agent output: the agent renders itself. The shipped config defines claude (`claude -p`). Adding an agent is config, not code. The engine depends on no agent (invariant 7).

## Commands

`run`, `resume`, `list`.

- `run`: typecheck + create + execute (run lifecycle above). Writes `.wa/tsconfig.json` when absent (components above). The `tsc` check reports position-accurate errors and blocks the run.
- `resume`: replay + continue, with an optional reply for the pending gate (run lifecycle above).
- `list`: a plain table: run, workflow, state, current step or pending gate question, age, run directory. Logs and transcripts are files in that directory: read them with any tool.

## Invariants

Each one line, each pinned by a test:

1. A run keeps a pinned copy of its workflow file, and replay executes the copy. Editing a definition never changes an existing run.
2. The journal is append-only. Replay of the pinned copy against its journal reaches the same live point with zero re-executed side effects.
3. At most one process executes a run at a time. A second `wa` process on the same run fails plainly with the holder's pid.
4. A run interrupted mid-step resumes from the step boundary. Completed steps never re-execute.
5. A gate consumes exactly one answer, and the answer is journaled. An invalid reply leaves the gate pending.
6. The sandbox exposes no ambient IO or time. A workflow cannot observe anything outside params, the step API, and the journal.
7. The engine depends on no agent and no default definition. With no agent configured and empty `~/.wa/workflows/` and `~/.wa/skills/`, the engine test suite passes.
