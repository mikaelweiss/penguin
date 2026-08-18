# protocol

**What.** The run directory on disk: `run.json`, `events.jsonl`, `inbox.jsonl`, the lock, and the credential store.

**Why.** A run's history is files, so any viewer can attach, leave, and join late without talking to the process. Closing a terminal never touches a run.
