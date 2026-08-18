# @mikaelweiss/penguin-engine

The run process, catalog discovery, and the author API (`workflow`, `adapter`).

penguin splits control flow from craft. This package is the control-flow half: it finds workflow and adapter files, starts a detached run, executes the run function, holds the lock, and appends events and transcripts. It owns no terminal. Closing a viewer never reaches here.

The starter catalog is this package's `examples/` directory. The engine itself depends on no adapter and no definition.
