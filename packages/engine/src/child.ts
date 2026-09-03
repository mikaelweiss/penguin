// The run process entrypoint: `bun child.ts <json>`. A parent's call and a frontend's start
// both spawn it with a job; a resume names only the run id and reads the rest from the run file.
// What fails before the run file opens is said on stderr, which a frontend keeps as the start log.
import fs from "node:fs";
import path from "node:path";
import { messageOf, RunPaused } from "./core/errors.ts";
import { runDir } from "./paths.ts";
import { run, runHead, signalChildren, type RunOptions } from "./run.ts";

type Job = {
  id: string;
  resume?: boolean;
  file?: string;
  params?: unknown;
  cwd?: string;
  parent?: string;
  catalogs?: RunOptions["catalogs"];
};

const job = JSON.parse(process.argv[2] ?? "") as Job;

function note(entry: Record<string, unknown>): void {
  const dir = runDir(job.id);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  fs.appendFileSync(path.join(dir, "run.jsonl"), `${line}\n`);
}

process.on("SIGTERM", () => {
  signalChildren("SIGTERM");
  note({ stopped: true });
  process.exit(143);
});

process.on("SIGINT", () => {
  signalChildren("SIGINT");
  note({ paused: { by: "user" } });
  process.exit(130);
});

function started(): Job {
  if (job.resume !== true) return job;
  const head = runHead(job.id);
  if (head === undefined) throw new Error(`${job.id} has no run to resume`);
  return {
    id: job.id,
    resume: true,
    file: head["workflow"] as string,
    params: head["params"],
    cwd: head["cwd"] as string,
    parent: head["parent"] as string | undefined,
    catalogs: head["catalogs"] as RunOptions["catalogs"],
  };
}

try {
  const given = started();
  await run(given.file ?? "", given.params, {
    cwd: given.cwd,
    id: given.id,
    parent: given.parent,
    catalogs: given.catalogs,
    resume: given.resume,
  });
  process.exit(0);
} catch (error) {
  if (error instanceof RunPaused) process.exit(130);
  console.error(messageOf(error));
  process.exit(1);
}
