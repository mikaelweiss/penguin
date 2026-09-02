import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installedIn, pick } from "./catalog/adapters.ts";
import { builtinCatalog, checkoutOf, roots, type Catalog } from "./catalog/catalogs.ts";
import { load } from "./catalog/loader.ts";
import { skillLookup } from "./catalog/skills.ts";
import { Fault, messageOf, PenguinError, RunCrashed, RunStopped } from "./core/errors.ts";
import { createRescue, worldOf } from "./core/rescue.ts";
import type { Adapter, Host } from "./core/adapter.ts";
import { settledStatus, type View } from "./core/view.ts";
import { RUN, type RunHooks } from "./core/workflow.ts";
import { z } from "zod";
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
  const { cwd, list } = where(file, options?.cwd ?? process.cwd(), options?.catalogs);
  const definition = await load(file, list);
  const parsed: unknown = definition.params.parse(params);
  const id = options?.id ?? runId();
  const journal =
    options?.resume === undefined ? undefined : openJournal(options.resume, file, parsed);
  const trace = createTrace(
    { id, workflow: file, params: parsed, cwd, root: projectRoot(cwd), parent: options?.parent },
    journal,
  );
  // Wiring the adapters is inside the try: a catalog that will not load is a failure of this run,
  // and a caller reads what stopped it from the run file like any other.
  try {
    const host = createHost(cwd, { id, dir: trace.dir }, skillLookup(list));
    const found = await installedIn(list);
    const ctx: Record<PropertyKey, unknown> = { params: parsed };
    const rescue = createRescue(worldOf(ctx));
    const installed: Adapter[] = [];
    for (const role of new Set(found.map((entry) => entry.role))) {
      const picked = pick(found, role);
      if ("missing" in picked) throw new PenguinError(picked.missing);
      if ("conflict" in picked) throw new PenguinError(picked.conflict);
      installed.push(picked.found.definition as Adapter);
      const built = picked.found.definition.build(host);
      const traced = trace.wrap(role, built);
      // The view asks and the agent turns are how faults get handled, so wrapping
      // them in the same recovery would ask about the asking.
      if (role === "view") ctx[role] = settledStatus(traced as View);
      else if (role === "agent") ctx[role] = traced;
      else ctx[role] = rescue(role, traced);
    }
    ctx[RUN] = hooks(trace, id, cwd, list);
    // A child run works where its parent already checked, so only a root run pays for preflight.
    if (options?.parent === undefined) await preflight(installed, host, ctx);
    // The loader duck-typed the definition, so its schema's static type is gone here.
    const result = await definition.run(reached(ctx) as never);
    trace.note({ outcome: result ?? null });
    return result;
  } catch (error) {
    trace.note({ threw: messageOf(error) });
    throw error;
  }
}

/**
 * Where the run happens and what it can reach. A workflow written on a branch runs in that
 * branch's checkout, so the catalog it came from is the project's and its adapters are live,
 * exactly as they will be once it merges. A sub-run is handed catalogs by the parent, which
 * already chose its folder, so nothing here moves it.
 */
function where(
  file: string,
  cwd: string,
  given: Catalog[] | undefined,
): { cwd: string; list: Catalog[] } {
  if (given !== undefined) return { cwd, list: [...given, builtinCatalog()] };
  const list = roots(cwd);
  const checkout = checkoutOf(list, file);
  return checkout === undefined ? { cwd, list } : { cwd: checkout, list: roots(checkout) };
}

/**
 * The ctx a workflow reads its adapters from. A role nothing installed is named on the read,
 * because it otherwise passes as undefined and surfaces as a type error at the first call,
 * whole agent turns after the run began.
 */
function reached(ctx: Record<PropertyKey, unknown>): Record<PropertyKey, unknown> {
  return new Proxy(ctx, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === "string") throw new PenguinError(`no ${key} adapter is installed`);
      return undefined;
    },
  });
}

const Preflight = z.enum(["retry", "skip", "stop"]);

/**
 * Every installed adapter's fast local checks, before the workflow runs. What
 * blocks the run surfaces at second zero with a person watching, not an hour in
 * at a git hook. The person fixes and retries, skips past a check they know
 * better than, or stops.
 */
async function preflight(
  installed: Adapter[],
  host: Host,
  ctx: Record<PropertyKey, unknown>,
): Promise<void> {
  for (;;) {
    const problems: string[] = [];
    for (const definition of installed) {
      if (definition.check === undefined) continue;
      problems.push(...(await definition.check(host)));
    }
    if (problems.length === 0) return;
    const view = ctx["view"] as View | undefined;
    const listed = problems.map((problem) => `- ${problem}`).join("\n");
    if (view === undefined || typeof view.ask !== "function") {
      throw new Fault(`the run cannot start:\n${listed}`);
    }
    const answer = await view.ask(
      `These block the run:\n\n${listed}\n\nretry runs the checks again once they are fixed, skip runs the workflow anyway, stop ends the run.`,
      Preflight,
    );
    if (answer === "skip") return;
    if (answer === "stop") throw new Fault(`the run cannot start:\n${listed}`);
  }
}

type Job = { workflow: string; params: unknown; cwd?: string };

function hooks(trace: Trace, parent: string, cwd: string, catalogs: Catalog[]): RunHooks {
  const perform = async (job: Job): Promise<unknown> => {
    const child = runId();
    trace.note({ child, workflow: job.workflow });
    return spawnRun({
      file: job.workflow,
      params: job.params,
      cwd: job.cwd ?? cwd,
      id: child,
      parent,
      catalogs,
    });
  };
  const wrapped = trace.wrapCall("run", perform);
  // A child without a folder of its own records the job it always did, so prior runs still replay.
  return {
    spawn: (file, params, at) =>
      wrapped(at === undefined
        ? { workflow: file, params }
        : { workflow: file, params, cwd: path.resolve(cwd, at) }),
  };
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
