# run

**What.** One workflow execution, and the files that make it observable.

A run is a detached process. Its directory holds `run.json` (what to run), `events.jsonl` (everything that happened), `inbox.jsonl` (everything sent in), a `lock` (who is executing), and `transcripts/` (what each agent session saw and said). A frontend only ever reads and appends these files: closing a viewer never reaches the process.

`execute.ts` is the process: lock, load, ctx, adapter steps, derived state. `turns.ts` is agent sessions. `inbox.ts` is gates and messages. `runner.ts` is the file `start.ts` launches, so the entry belongs to the engine and no frontend supplies it.
