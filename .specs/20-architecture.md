# Architecture

## Components

- **CLI (TypeScript)**: one npm package, one `wa` command, the whole engine: command parsing, journal, replay, step dispatch, agent spawning, output rendering. It runs on system Node (20 or newer), one foreground process per executing run. No daemon, no socket, no database server. Each `wa run`, `wa resume`, or `wa answer` executes exactly one run in the foreground.
- **Workflow loading**: wa bundles the workflow file with esbuild (a library dependency) and evaluates the bundle in a sandboxed `node:vm` context. The context exposes standard JS builtins, the `wa` package, and zod, and nothing else: no `Date.now`, `Math.random`, `fetch`, `fs`, or timers. Local imports bundle in, so reuse across files is plain functions. A step API call is a direct function call into the engine, which journals the call and its result. Replay re-executes the bundle while the journal answers each call in sequence, until execution reaches the first unanswered call and goes live.
- **wa package (TypeScript)**: the types workflow authors import (`workflow`, `param`, `wa/std`), part of wa itself, with zod as a bundled dependency. `wa init` writes a `tsconfig.json` into `.wa/` that maps `wa` and `zod` to the installed wa package, so editor LSP and the `tsc` inside `wa lint` resolve the same types. The user's repo needs no npm install.

The engine core defines no specific agent, workflow, or skill. What a fresh install ships is the catalog in `30-defaults.md`, and every entry is removable.

## Storage

Plain files, no database.

- `~/.wa/projects/<id>/runs/<name>/`: one directory per run. `run.json` (status, params, workflow hash, timestamps), `journal.jsonl` (append-only), `workflow.js` (the pinned compiled bundle), `logs/` (engine log, one transcript per agent invocation), `artifacts/`, `lock` (held by the executing process).
- `~/.wa/config.toml`: agent entries (command templates), default agent, default model.
- `~/.wa/workflows/`, `~/.wa/skills/`: personal definitions. Install seeds them with the default set (`30-defaults.md`).

## Project identity

`<id>` derives from the first remote URL when one exists, else the absolute path of the main working copy. Worktrees resolve to the main repo (`git worktree list`), so a run started in a worktree stores state under the same project. A folder with no repository is its own project by path. The run records which folder or worktree it executed in.

## Run lifecycle

`wa run <workflow> [params]` validates params, creates the run, and executes it in the foreground. Each agent step spawns the agent CLI in print mode and streams the transcript to the terminal and to the run log. The step ends when the agent writes `result.json` to the path wa supplies with the step prompt. The engine validates it against the step's schema (the retry rule is in `10-workflow-model.md`).

A gate prompts in the terminal. When the process has no terminal (cron) or the user does not answer, the run parks: the process exits, and the run waits on disk with the question recorded.

Ctrl-C parks the run: the in-flight step stops, the journal keeps every completed step, and resume re-dispatches from the step boundary.

- `wa resume <run>` replays the journal and continues in the foreground. A pending gate prompts again.
- `wa answer <run> <reply>` journals the reply and resumes the run in the foreground. When the gate has options, a reply outside them is rejected and the gate stays pending.
- `wa stop <run>` marks a parked run stopped. It does not resume.

A lock file makes execution exclusive: a second wa process on the same run fails plainly with the holder's pid.

Schedules are not wa's job: OS cron calling `wa run` covers them.

## Agents

An agent is an entry in `config.toml`: the executable and how to pass a prompt and a model. wa builds the step prompt (input, skill content, result path), spawns the command, streams the transcript, and validates `result.json`. The shipped config defines claude (`claude -p --output-format stream-json`). Adding an agent is config, not code. The engine depends on no agent (invariant 9).

## Workspaces

`step.workspace` shells out to git: `git worktree add` and `git worktree remove`, base branch detection from the invoking folder. The lifecycle rule is invariant 7.

## Commands

`init`, `run`, `resume`, `answer`, `stop`, `list`, `logs`, `which`, `skills`, `lint`, `sim`.

- `run`: create + execute (run lifecycle above). `--output json` prints the run output to stdout. Lint failure blocks `wa run` unless `--force`.
- `list`: a plain table grouped by project: run, workflow, state, current step or pending gate question, age.
- `logs <run>`: print the engine log, `--step <n>` for one agent transcript.
- `skills`: `wa skills import <path>` copies a skill file into `~/.wa/skills/`. `--repo` writes to `.wa/skills/` instead.
- `lint`: esbuild parse, `tsc` typecheck against the wa package types, banned-global scan, side-effect-free manifest check, skill reference resolution. Position-accurate errors.
- `sim <workflow> --fixture <file>`: execute the real run function with every primitive answered from the fixture instead of the engine. A fixture is a JSON file: `params` and an ordered list of `{match, result}` entries that answer primitive calls. Sim runs through the replay layer: a fixture is a pre-seeded journal. The entries are also the assertion: a call that does not match the next entry fails the sim, and so does an unconsumed entry at the end. Prints the trace. Lint catches invalid workflows, sim catches valid-but-wrong ones. Together they let an author, human or AI, write and test a workflow without one agent call.

## Invariants

Each one line, each pinned by a test:

1. A run pins the content hash and a copy of its compiled workflow bundle. Editing a definition never changes an existing run.
2. The journal is append-only. Replay of an unchanged bundle against its journal reaches the same live point with zero re-executed side effects.
3. At most one process executes a run at a time. A second `wa` process on the same run fails plainly with the holder's pid.
4. A run interrupted mid-step resumes from the step boundary. Completed steps never re-execute.
5. A gate consumes exactly one answer, and the answer is journaled. An invalid reply leaves the gate pending.
6. Limits are checked by the engine before each step dispatch, never by workflow code or agents.
7. A run's worktree is removed exactly when the run exits clean and `keep` is false. Failed and stopped runs keep theirs for inspection.
8. The sandbox exposes no ambient IO or time. A workflow that lints clean cannot observe anything outside params, the step API, and the journal.
9. The engine depends on no agent and no default definition. With no agent configured and empty `~/.wa/workflows/` and `~/.wa/skills/`, the engine test suite passes.
