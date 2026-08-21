# @mikaelweiss/penguin-engine

The whole of penguin. Frontends are windows into it, and none live here.

- `src/core/` defines what a workflow and an adapter are. Start there: [src/core/README.md](src/core/README.md).
- `src/catalog/` finds workflow and adapter files across catalog directories.
- `src/host.ts` implements the `Host` an adapter builds against.
- `src/run.ts` wires one workflow file to its adapters and runs it. Frontends call this.
- `src/trace.ts` logs each adapter call, so a finished run can say what it did.
- `examples/` is the starter catalog: the terminal view, git, claude, and workflows to copy from.
- `tests/` holds the starter catalog's tests; engine tests sit next to their sources. `bun test` runs both.

`examples/run.ts` runs one workflow in the foreground with the starter adapters:

```sh
bun examples/run.ts examples/workflows/commit.ts '{"dir":"."}'
```
