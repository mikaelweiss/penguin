# Architecture

## Components

- **CLI (Go)**: one binary, the whole engine: command parsing, journal, replay, step dispatch, agent spawning, output rendering. No daemon, no socket, no database server. Each `wa run`, `wa resume`, or `wa answer` executes exactly one run in the foreground.
- **Runner (TypeScript, embedded)**: a prebuilt `runner.js`, bundled with esbuild at wa's build time and embedded in the Go binary. wa spawns it with the system Node, one process per executing run. It loads the workflow file in a sandboxed context (no `Date.now`, `Math.random`, `fetch`, `fs`, or timers) and proxies every step API call to the Go process over stdio. wa journals each call and its result. Replay re-executes the script while the journal answers proxied calls until the first unanswered one. wa requires Node on the machine and says so plainly when absent. Every coding agent wa drives is itself a Node app, so the audience already has it.
- **wa package (TypeScript)**: the types workflow authors import (`workflow`, `param`, `result`, `wa/std`). Ships with wa, resolved locally, no npm install required. wa materializes the package and its bundled zod dependency under `~/.wa/runtime/<version>/`. `wa init` writes a `tsconfig.json` into `.wa/` that maps `wa` and `zod` there, so editor LSP and the `tsc` inside `wa lint` resolve the same types.

The engine core defines no specific agent, workflow, or skill. What a fresh install ships is the catalog in `30-defaults.md`, and every entry is removable.

## Storage

Plain files, no database.

- `~/.wa/projects/<id>/runs/<name>/`: one directory per run. `run.json` (status, params, workflow hash, timestamps), `journal.jsonl` (append-only), `workflow.ts` (the pinned copy), `logs/` (engine log, one transcript per agent invocation), `artifacts/`, `lock` (held by the executing process).
- `~/.wa/config.toml`: agent entries (command templates), default agent, default model.
- `~/.wa/runtime/<version>/`: the materialized wa TypeScript package and bundled zod.
- `~/.wa/workflows/`, `~/.wa/skills/`: personal definitions. Install seeds them with the default set (`30-defaults.md`).

## Project identity

`<id>` derives from the first remote URL when one exists, else the absolute path of the main working copy. Worktrees resolve to the main repo (`git worktree list`), so a run started in a worktree stores state under the same project. A folder with no repository is its own project by path. The run records which folder or worktree it executed in.

## Run lifecycle

`wa run <workflow> [params]` validates params, creates the run, and executes it in the foreground. Each agent step spawns the agent CLI in print mode and streams the transcript to the terminal and to the run log. The step ends when the agent writes `result.json` to the path wa supplies with the step prompt. The engine validates it against the step's schema (the retry rule is in `10-workflow-model.md`).

A gate prompts in the terminal. When the process has no terminal (cron) or the user does not answer, the run parks: the process exits, and the run waits on disk with the question recorded.

Ctrl-C parks the run: the in-flight step stops, the journal keeps every completed step, and resume re-dispatches from the step boundary.

- `wa resume <run>` replays the journal and continues in the foreground. A pending gate prompts again.
- `wa answer <run> <reply>` validates the reply against the pending gate, journals it, and resumes the run in the foreground.
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
- `skills`: `wa skills import <path>` copies a skill file into `~/.wa/skills/`. `--repo` writes to `.wa/skills/` instead. `--link` makes a symlink instead of a copy. The OS resolves a chain of symlinks, so an import from a symlinked `~/.claude` works.
- `lint`: esbuild parse, `tsc` typecheck against the wa package types, banned-global scan, side-effect-free manifest check, skill reference resolution. Position-accurate errors.
- `sim <workflow> --fixture <file>`: execute the real run function with every primitive answered from the fixture instead of the engine. A fixture is a JSON file: `params`, an ordered list of `{match, result}` entries that answer primitive calls, and `expect`, the primitive-call trace the run must produce. Prints the trace and checks the expectations. Lint catches invalid workflows, sim catches valid-but-wrong ones. Together they let an author, human or AI, write and test a workflow without one agent call.

## Invariants

Each one line, each pinned by a test:

1. A run pins the content hash and a copy of its workflow file. Editing a definition never changes an existing run.
2. The journal is append-only. Replay of an unchanged script against its journal reaches the same live point with zero re-executed side effects.
3. At most one process executes a run at a time. A second `wa` process on the same run fails plainly with the holder's pid.
4. A run interrupted mid-step resumes from the step boundary. Completed steps never re-execute.
5. A gate consumes exactly one answer, and the answer is journaled. An invalid reply leaves the gate pending.
6. Limits are checked by the engine before each step dispatch, never by workflow code or agents.
7. A run's worktree is removed exactly when the run exits clean and `keep` is false. Failed and stopped runs keep theirs for inspection.
8. The sandbox exposes no ambient IO or time. A workflow that lints clean cannot observe anything outside params, the step API, and the journal.
9. The engine depends on no agent and no default definition. With no agent configured and empty `~/.wa/workflows/` and `~/.wa/skills/`, the engine test suite passes.
