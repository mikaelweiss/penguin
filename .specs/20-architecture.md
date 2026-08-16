# Architecture

## Components

- **CLI client (Go)**: parses commands, talks to the daemon over a unix socket at `~/.wa/daemon.sock`, renders output (plain or TUI). One binary with the daemon.
- **Daemon (Go)**: auto-started by the first command that needs it. Owns run state, journals, mailboxes, event subscriptions, schedulers, pools, and step execution. The single writer to the database.
- **Runner (TypeScript, embedded)**: a prebuilt `runner.js`, bundled with esbuild at wa's build time and embedded in the Go binary. The daemon spawns it with the system Node, or Bun when Node is absent (`runtime` in `config.toml` overrides), one process per executing run. It loads the workflow file in a sandboxed context (no `Date.now`, `Math.random`, `fetch`, `fs`, or timers) and proxies every step API call to the daemon over stdio. The daemon journals each call and its result. Replay re-executes the script while the journal answers proxied calls until the first unanswered one. wa requires Node or Bun on the machine and says so plainly when absent. Every coding agent wa drives is itself a Node app, so the audience already has it.
- **wa package (TypeScript)**: the types workflow authors import (`workflow`, `param`, `result`, `wa/std`, and each adapter's typed module under `wa/adapters`). Ships with wa, resolved locally, no npm install required. wa materializes the package and its bundled zod dependency under `~/.wa/runtime/<version>/`. `wa init` writes a `tsconfig.json` into `.wa/` that maps `wa` and `zod` there, so editor LSP and the `tsc` inside `wa lint` resolve the same types. The same types serve any future UI client.

The engine core defines no specific adapter, workflow, or skill. What a fresh install ships is the catalog in `30-defaults.md`, and every entry is removable.

## Storage

- `~/.wa/wa.db`: SQLite (WAL mode). Tables: projects, workflows (registered file hashes), runs, journal, messages, queue, audit. The daemon is the only writer. Clients read through the daemon.
- `~/.wa/projects/<id>/runs/<name>/`: plain files. `logs/` (engine log, one transcript per agent invocation), `artifacts/`, `workflow.ts` (the pinned copy).
- `~/.wa/config.toml`: default agent, default model, cheap tier per agent, runner runtime, provider tokens or env var references, channel bindings, ingress settings.
- `~/.wa/runtime/<version>/`: the materialized wa TypeScript package and bundled zod.
- `~/.wa/workflows/`, `~/.wa/skills/`: personal definitions. Install seeds them with the default set (`30-defaults.md`).

## Project identity

`<id>` derives from the first remote URL when one exists, else the absolute path of the main working copy. Worktrees resolve to the main repo (`git worktree list`, jj workspace root), so a run started in a worktree stores state under the same project. A folder with no repository is its own project by path. The run records which folder or worktree it executed in.

## Executor modes

1. **headless**: the daemon spawns the agent CLI in print mode (`claude -p --output-format stream-json`), streams the transcript into run logs, validates the result envelope.
2. **interactive**: `wa run` (attached) spawns the real agent CLI on the user's terminal via pty, wired to the run. The user watches and can type to the agent. When the step ends, wa takes the terminal back.
3. **in-session**: the user is already inside an agent session. The agent drives the run: `wa next` prints the current step's prompt, skill, and state slice. The agent does the work, then `wa done <run> <step> --result <file>` advances.
4. **command**: no agent.

Interactive mode is only available while attached. A detached run downgrades interactive steps to a gate asking the user to attach.

In every agent mode, the step ends when the agent writes `result.json` to the path wa supplies with the step prompt. The engine validates it against the step's schema (the retry rule is in `10-workflow-model.md`).

## Attach protocol

Runs live in the daemon. `wa run` = create + attach (foreground, streaming logs, `q` or `d` detaches). No attach keybind stops a run: stopping is always the explicit `wa stop`. `wa run --detach` backgrounds immediately. `wa run` always creates a run: with params it runs the body once, with no params on an event-triggered workflow it creates the watcher run (`10-workflow-model.md`, triggers). The engine applies dedup, pool, and priority when the watcher spawns a body run, the same as any spawn. `wa attach <run>` reconnects any terminal. Multiple viewers may attach read-only. Any client that speaks the socket protocol (a web or desktop UI) gets the same view.

## Adapter interfaces

Four small interfaces. Everything provider-specific implements one. An adapter also ships its typed TypeScript module (`wa/adapters/<name>`): the types and request builders workflow authors use. wa defines no provider-neutral entity model. Adding an adapter adds types. Deleting one breaks only the workflows that name it, at typecheck time, with file and line.

- **Agent**: `Invoke(step, mode) -> transcript stream + result`. Knows how to spawn one CLI headless or interactive, and how to name a run with its cheap tier. Declares whether it accepts mid-session input: when it cannot, `inject` degrades to `restart`.
- **EventSource**: `Subscribe(request) -> messages`. The request is the typed, declarative object built in workflow code (`github.issue.labeled("wa")`). The adapter translates it into polling or webhook registration. Polling sources wrap a provider API on an interval and dedupe by provider event id. Push sources register with the ingress listener.
- **Channel**: `Send(message)` and, when two-way, `Receive() -> messages`. A gate's question goes out on every bound two-way channel, and the first valid reply consumes it.
- **VCS**: `Root`, `MainWorkingCopy`, `ProjectID`, `CurrentBranch`, `CreateWorktree`, `RemoveWorktree`. Implemented for git and jj.

The engine core imports no adapter. Each adapter registers itself, and a build with none still passes the engine test suite. The pre-built set is the catalog in `30-defaults.md`.

## Event ingress

- Polling is the default: per-subscription interval, provider event ids for dedupe.
- A subscription exists only while a run wants it: a watcher run, or a run parked on an adapter-subscription `receive`. The daemon starts and stops pollers to match.
- Local HTTP listener for custom webhooks: `wa webhook url <workflow>` prints the endpoint + token.
- Optional tunnel config (cloudflared, smee) for true push.

## Auth

Reuse existing CLI credentials where they exist (`gh auth` for GitHub). Other providers: token in an env var, referenced from `config.toml`. wa stores no OAuth flows of its own.

## Commands

`init`, `run`, `ps`, `attach`, `logs`, `send`, `answer`, `rename`, `stop`, `lint`, `sim`, `graph`, `which`, `skills`, `webhook`, `next`, `done`, `daemon`.

- `skills`: `wa skills import <path>` copies a skill file into `~/.wa/skills/`. `--repo` writes to `.wa/skills/` instead. `--link` makes a symlink instead of a copy. The OS resolves a chain of symlinks, so an import from a symlinked `~/.claude` works.
- `answer`: a convenience form of `send`. It shapes the reply to a run's pending gate, so the sender does not hand-write the message the gate expects.
- `ps` with no flags opens the TUI: grouped by project, columns for run, workflow, state, current step, age. Single-letter sort keys, hjkl and arrows to move, enter or space to attach, `q` to quit. `ps --plain` prints a parseable table.
- `lint`: esbuild parse, `tsc` typecheck against the wa package types, banned-global scan, side-effect-free manifest check, skill reference resolution. Position-accurate errors. Lint failure blocks `wa run` unless `--force`.
- `sim <workflow> --fixture <file>`: execute the real run function with every primitive answered from the fixture instead of the daemon. A fixture is a JSON file: `params`, an ordered list of `{match, result}` entries that answer primitive calls, and `expect`, the primitive-call trace the run must produce. Prints the trace and checks the expectations. Lint catches invalid workflows, sim catches valid-but-wrong ones. Together they let an author, human or AI, write and test a workflow without one agent call.
- `graph`: draws the primitive-call paths recorded from sims and real runs, mermaid out.

## Invariants

Each one line, each pinned by a test:

1. The daemon is the only DB writer. Client mutations go through the socket.
2. A run pins the content hash and a copy of its workflow file. Editing a definition never changes a live run.
3. The journal is append-only. Replay of an unchanged script against its journal reaches the same live point with zero re-executed side effects.
4. A message is delivered exactly once per run: dedupe on `(run, source, provider_id)`.
5. A mid-step message follows the step's interrupt policy (default queue). No message drops: queued messages keep order, injected and restart-consumed messages are journaled.
6. Daemon restart resumes every non-terminal run by replay. A runner process that dies mid-step restarts from the step boundary.
7. A stopped or exited run releases its concurrency key and pool slot atomically with its status change.
8. A gate reply consumes exactly one matching message. Later replies stay in the mailbox.
9. Limits are checked by the engine before each step dispatch, never by workflow code or agents.
10. Renames change only the display name. Every FK uses the internal id.
11. Stopping a run stops its non-detached children, recursively. A parent that awaits children accounts for every child it started: none leak.
12. Pool and `parallelMap` concurrency are enforced by the engine scheduler, never by the children.
13. Queued triggers start in priority order (FIFO within equal priority), one per freed slot, and re-check dedup at start time. The queue is persisted: a stopped daemon loses nothing.
14. A run's worktree is removed exactly when the run exits clean and `keep` is false. Failed and stopped runs keep theirs for inspection.
15. The sandbox exposes no ambient IO or time. A workflow that lints clean cannot observe anything outside params, the step API, and the journal.
16. The engine depends on no adapter and no default definition. A build with zero adapters, on an install with empty `~/.wa/workflows/` and `~/.wa/skills/`, passes the engine test suite.
