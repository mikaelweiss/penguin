# wa

Read `.specs/` before any work. It is the source of truth:

- `.specs/00-product.md`: what wa is, principles, glossary.
- `.specs/10-workflow-model.md`: manifest fields, the step API, determinism rules, replay.
- `.specs/20-architecture.md`: components, storage, adapters, commands, invariants.
- `.specs/30-defaults.md`: the catalog a fresh install ships: pre-built adapters, default workflows.

The specs describe the final product. They contain no milestones, phases, or build order.

## Settled decisions

These were argued and closed. Do not reopen them:

- Engine (CLI + daemon) is Go. Workflow files are TypeScript, executed by a sandboxed runner subprocess on system Node/Bun with journaled replay. A YAML/CEL schema and Starlark were both considered and rejected.
- Manifests are data, workflow bodies are code. New control-flow needs become stdlib functions, never schema fields.
- Run state lives under `~/.wa/`, never in a repo.
- zod for result schemas (`z.*` types). `param.*` declares workflow inputs only. Skills are markdown with no control flow.
- No workflow inheritance. Reuse is functions and child workflows.
- No `arm` command. Listening is a watcher run: `wa run` with no params on an event-triggered workflow creates it, `wa stop` ends it. Catch-up over existing items is workflow code, not a flag.
- Adapters own their types (`wa/adapters/<name>`). wa has no provider-neutral entity model, and the daemon never routes by inference: a workflow names the adapters it uses and sees only typed objects. Subscriptions are typed requests with declarative arguments, never filter functions over raw provider events.
- Gates broadcast on every bound channel and the first valid reply wins. No per-person addressing.
- Mid-step messages follow a per-step `interrupt` policy (queue, inject, restart) declared in workflow code. Agent steps only.
- The core ships empty. Adapters, default workflows, and skills are removable catalog entries in `.specs/30-defaults.md`. The core specs define no specific workflow, adapter, or skill. Personal workflow ideas go in `WORKFLOWS.md`.
- wa resolves skills from its own directories and sends the file content with the step prompt. Agent skill directories (`~/.claude/skills`, `~/.agents/skills`) are import sources only (`wa skills import`).

## Conventions

- Every engine invariant in `20-architecture.md` is pinned by a test. A change that touches one updates its test.
- Spec and code move together: a behavior change lands with its spec edit in the same commit.
- Quality gates for every change: `go vet`, `golangci-lint run`, and `go test ./... -race` pass. Runner tests pass under Node and Bun.
- `wa lint` rejects each documented invalid case (type error, banned global, side-effecting manifest, unknown skill) with file and line.
