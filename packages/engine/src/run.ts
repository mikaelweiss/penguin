import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installedIn, pick } from "./catalog/adapters.ts";
import { builtinCatalog, roots, type Catalog } from "./catalog/catalogs.ts";
import { load } from "./catalog/loader.ts";
import { PenguinError, RunCrashed, RunStopped } from "./core/errors.ts";
import { RUN, type RunHooks } from "./core/workflow.ts";
import { createHost } from "./host.ts";
import { projectRoot, runDir } from "./paths.ts";
import { createTrace, openJournal, runId, type Trace } from "./trace.ts";

export { createHost } from "./host.ts";
export { latestRun, runId } from "./trace.ts";

export type RunOptions = {
  /** The run's invoking folder. Defaults to the process's. */
  cwd?: string;
  /** The catalogs to draw adapters from. Defaults to roots(cwd). Builtins always append. */
  catalogs?: Catalog[];
  /** The run's id, when the caller claimed one with runId() to know the run folder up front. */
  id?: string;
  /** The parent run's id. The engine sets it when it spawns a sub-run. */
  parent?: string;
  /** A prior run's file. Recorded calls replay from it; the run goes live at the first call it does not hold. */
  resume?: string;
};

/** Loads one workflow file, validates its params, wires the installed adapters onto ctx, and runs it. */
export async function run(
  file: string,
  params: unknown = {},
  options?: RunOptions,
): Promise<unknown> {
  const cwd = options?.cwd ?? process.cwd();
  const definition = await load(file);
  const parsed: unknown = definition.params.parse(params);
  const id = options?.id ?? runId();
  const journal =
    options?.resume === undefined ? undefined : openJournal(options.resume, file, parsed);
  const trace = createTrace(
    { id, workflow: file, params: parsed, cwd, root: projectRoot(cwd), parent: options?.parent },
    journal,
  );
  const list =
    options?.catalogs === undefined ? roots(cwd) : [...options.catalogs, builtinCatalog()];
  const host = createHost(cwd, { id, dir: trace.dir }, list);
  const found = await installedIn(list);
  const ctx: Record<PropertyKey, unknown> = { params: parsed };
  for (const role of new Set(found.map((entry) => entry.role))) {
    const picked = pick(found, role);
    if ("missing" in picked) throw new PenguinError(picked.missing);
    if ("conflict" in picked) throw new PenguinError(picked.conflict);
    const built = picked.found.definition.build(host);
    ctx[role] = trace.wrap(role, built);
  }
  ctx[RUN] = hooks(trace, id, cwd, list);
  try {
    // The loader duck-typed the definition, so its schema's static type is gone here.
    const result = await definition.run(ctx as never);
    trace.note({ outcome: result ?? null });
    return result;
  } catch (error) {
    trace.note({ threw: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function hooks(trace: Trace, parent: string, cwd: string, catalogs: Catalog[]): RunHooks {
  const perform = async (job: { workflow: string; params: unknown }): Promise<unknown> => {
    const child = runId();
    trace.note({ child, workflow: job.workflow });
    return spawnRun({
      file: job.workflow,
      params: job.params,
      cwd,
      id: child,
      parent,
      catalogs,
    });
  };
  const wrapped = trace.wrapCall("run", perform);
  return { spawn: (file, params) => wrapped({ workflow: file, params }) };
}

type ChildConfig = {
  file: string;
  params: unknown;
  cwd: string;
  id: string;
  parent: string;
  catalogs: Catalog[];
};

/** Runs a child workflow as its own process and settles with the outcome its run file records. */
function spawnRun(config: ChildConfig): Promise<unknown> {
  const entry = fileURLToPath(new URL("./child.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, JSON.stringify(config)], {
      cwd: config.cwd,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const name = path.basename(config.file);
      const last = finalNote(config.id);
      if (last === undefined) {
        const said = stderr.trim() === "" ? "" : `: ${stderr.trim()}`;
        reject(new RunCrashed(`${name} died with ${signal ?? code}${said}`));
      } else if (last["stopped"] === true) {
        reject(new RunStopped(`${name} was stopped`));
      } else if ("outcome" in last) {
        resolve(last["outcome"]);
      } else {
        reject(new PenguinError(String(last["threw"])));
      }
    });
  });
}

/** The child run file's closing entry: outcome, threw, or stopped. */
function finalNote(id: string): Record<string, unknown> | undefined {
  const file = path.join(runDir(id), "run.jsonl");
  if (!fs.existsSync(file)) return undefined;
  const entries = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return entries
    .filter((entry) => entry["call"] === undefined)
    .findLast(
      (entry) => "outcome" in entry || "threw" in entry || entry["stopped"] === true,
    );
}
