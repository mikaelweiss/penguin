# run

**What.** One workflow execution: create the directory, start the detached process, run the function, list what is live.

**Why.** A run is a live process. This folder is that process — not the terminal, not the catalog, not the files a viewer reads.

`execute.ts` is the process: lock, load, ctx, adapter steps, derived state. `turns.ts` is agent sessions. `inbox.ts` is gates, messages, and credentials.
