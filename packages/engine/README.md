# @mikaelweiss/penguin-engine

The whole of penguin. Frontends are windows into it, and none live here.

The model, what a workflow and an adapter are and what the engine does, is in [src/core/README.md](src/core/README.md).

`examples/` is the starter catalog: the terminal view, git, claude, and workflows to copy from. Its tests live in `tests/`; engine tests sit next to their sources. `bun test` runs both.

`examples/run.ts` runs one workflow in the foreground with the starter adapters:

```sh
bun examples/run.ts examples/workflows/commit.ts '{"dir":"."}'
```
