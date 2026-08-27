// The sub-run entrypoint. call() spawns `bun child.ts <json>` with the job's
// file, params, cwd, id, parent, and catalogs; the run file carries the rest.
import fs from "node:fs";
import path from "node:path";
import { messageOf } from "./core/errors.ts";
import { runDir } from "./paths.ts";
import { run, type RunOptions } from "./run.ts";

type Job = {
  file: string;
  params: unknown;
  cwd: string;
  id: string;
  /** Absent when a frontend starts a root run this way. */
  parent?: string;
  catalogs: RunOptions["catalogs"];
};

const job = JSON.parse(process.argv[2] ?? "") as Job;

/** The closing line the parent reads. A run that dies without one is a crash nobody can explain. */
function note(entry: Record<string, unknown>): void {
  const dir = runDir(job.id);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  fs.appendFileSync(path.join(dir, "run.jsonl"), `${line}\n`);
}

process.on("SIGTERM", () => {
  note({ stopped: true });
  process.exit(143);
});

try {
  await run(job.file, job.params, {
    cwd: job.cwd,
    id: job.id,
    parent: job.parent,
    catalogs: job.catalogs,
  });
  process.exit(0);
} catch (error) {
  // run() records what threw once the run file is open. A failure before that has only this.
  const said = messageOf(error);
  note({ threw: said });
  console.error(said);
  process.exit(1);
}
