# @mikaelweiss/penguin

The `pn` command: install, list, run, attach, and the full-screen terminal.

This is what users install. It is the terminal on top of the viewer: a dashboard of live runs, a run view that watches and sends messages, and plain output when piped. Closing it never touches a run.

It re-exports the author API, so `import { workflow } from "penguin"` resolves from the package people already have.
