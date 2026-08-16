# wa

Read `.specs/` before any work. It is the source of truth:

- `.specs/00-product.md`: what wa is, principles, glossary.
- `.specs/10-workflow-model.md`: manifest fields, the step API, determinism rules, replay.
- `.specs/20-architecture.md`: components, storage, run lifecycle, commands, invariants.
- `.specs/30-defaults.md`: the catalog a fresh install ships: agent config, default workflows.

The specs describe the final product. They contain no milestones, phases, or build order.

## Settled decisions

These were argued and closed. Do not reopen them:

- Engine is TypeScript, one Node CLI, no daemon. A workflow is one self-contained TypeScript file: esbuild's single-file `transform` strips its types, and the result runs in a sandboxed vm context inside the engine process, with journaled replay. Bundling and local imports were cut. A YAML/CEL schema, Starlark, and a Go engine with a runner subprocess were all considered and rejected.
- No background machinery. The daemon, sockets, SQLite, event triggers, watchers, subscriptions, mailboxes, messages, channels, mid-step interrupt policies, dedup, pools, and queues were specced in full and then cut. A run is a foreground process, a parked run is files on disk, and a human or cron resumes it. Do not reintroduce any of it.
- No provider adapters. Provider IO is `step.command` with the provider's own CLI (`gh`, `linear`, `git`) under the user's existing credentials. An agent is a `config.toml` command template, not code. The engine has no git knowledge: a worktree is `git worktree add` through `step.command`, its path passed as a step `cwd`.
- Manifests are data, workflow bodies are code. New control-flow needs become plain TypeScript functions in the workflow file, never schema fields.
- Bare-minimum surface. Three commands: `run`, `resume`, `list`. These were specced and cut: `wa init` (folded into `wa run`, which writes the `.wa/` tsconfig when absent), `wa answer` (folded into `wa resume <run> [reply]`), `wa lint`, `wa sim` and fixtures, `wa stop`, `wa logs`, `wa which`, `wa skills import`, `limits.maxAgentCalls`, `ctx.sleep`, `ctx.now`, `ctx.log`, `step.workspace`, run outputs and `--output json` (a result leaves a run as an artifact or a `step.command` line), the manifest `defaults` field (executor is config default plus per-step override), the workflow content hash (a run keeps only the pinned copy), the `wa/std` stdlib, the `new-workflow` default workflow, project identity grouping, an internal run id, multi-repo workspaces, worktree auto-removal, and transcript stream parsing. Do not reintroduce any of them. Typechecking lives inside `wa run`, waiting is a gate plus cron, and agent output pipes through unchanged.
- Run state lives under `~/.wa/`, never in a repo.
- zod for params and result schemas (`z.*` types), one vocabulary for both. Skills are markdown with no control flow.
- No workflow inheritance and no child workflows. Reuse is plain TypeScript functions.
- Gates are CLI only: the question prompts in the terminal or parks the run for `wa resume <run> <reply>`. One answer per gate.
- The core ships empty. The default agent config, default workflows, and skills are removable catalog entries in `.specs/30-defaults.md`. The core specs define no specific workflow, agent, or skill. Personal workflow ideas go in `WORKFLOWS.md`.
- wa resolves skills from its own directories and sends the file content with the step prompt. Agent skill directories (`~/.claude/skills`, `~/.agents/skills`) are import sources only: copy a file in by hand.

## Conventions

- Every engine invariant in `20-architecture.md` is pinned by a test. A change that touches one updates its test.
- Spec and code move together: a behavior change lands with its spec edit in the same commit.
- Quality gates for every change: `tsc --noEmit` and the test suite (`node --test`) pass under system Node.
- `wa run` rejects a workflow with a type error before it creates the run, with file and line.
