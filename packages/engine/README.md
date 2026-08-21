# @mikaelweiss/penguin-engine

The whole of penguin. Frontends are windows into it, and none live here.

Three folders under `src/`, in dependency order:

- `core/` defines what a workflow, an adapter, and a message are. Start there: [src/core/README.md](src/core/README.md).
- `catalog/` finds workflow and adapter files across catalog directories.
- `run/` executes one workflow as a detached process and keeps its history as files any frontend can read.

`examples/` is the starter catalog: a small set of real definitions to copy from.
