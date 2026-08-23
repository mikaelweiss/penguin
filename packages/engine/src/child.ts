// The sub-run entrypoint. call() spawns `bun child.ts <json>` with the job's
// file, params, cwd, id, parent, and catalogs; the run file carries the rest.
import fs from "node:fs";
import path from "node:path";
import { runDir } from "./paths.ts";
import { run, type RunOptions } from "./run.ts";

type Job = {
  file: string;
  params: unknown;
  cwd: string;
  id: string;
  parent: string;
  catalogs: RunOptions["catalogs"];
};

const job = JSON.parse(process.argv[2] ?? "") as Job;

process.on("SIGTERM", () => {
  const file = path.join(runDir(job.id), "run.jsonl");
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), stopped: true })}\n`);
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
} catch {
  // The run file already records what threw.
  process.exit(1);
}
