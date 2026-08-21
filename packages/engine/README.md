# @mikaelweiss/penguin-engine

The whole of penguin. Frontends are windows into it, and none live here.

- `src/core/` defines what a workflow and an adapter are. Start there: [src/core/README.md](src/core/README.md).
- `src/catalog/` finds workflow and adapter files across catalog directories.
- `src/host.ts` implements the `Host` an adapter builds against.
- `examples/` is the starter catalog: the terminal view, git, claude, and workflows to copy from.

`examples/run.ts` runs one workflow in the foreground with the starter adapters:

```sh
bun examples/run.ts examples/workflows/commit.ts '{"dir":"."}'
```
