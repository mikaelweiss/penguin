import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routeAgents } from "./agents.ts";
import { installedIn, pick } from "./catalog/adapters.ts";
import { builtinCatalog, checkoutOf, roots, type Catalog } from "./catalog/catalogs.ts";
import { load } from "./catalog/loader.ts";
import { skillLookup } from "./catalog/skills.ts";
import {
  Fault,
  messageOf,
  PenguinError,
  RunCrashed,
  RunPaused,
  RunStopped,
} from "./core/errors.ts";
import { createRescue, worldOf } from "./core/rescue.ts";
import type { Adapter, Host } from "./core/adapter.ts";
import { settledStatus, type View } from "./core/view.ts";
import { RUN, type RunHooks } from "./core/workflow.ts";
import { z } from "zod";
import { createHost } from "./host.ts";
import { projectRoot, runDir } from "./paths.ts";
import {
  closingOf,
  createTrace,
  livePid,
  openJournal,
  runHead,
  runId,
  safe,
  type Entry,
  type Trace,
} from "./trace.ts";

export { createHost } from "./host.ts";
export { runHead, runId } from "./trace.ts";

export type RunOptions = {
  /** The run's invoking folder. Defaults to the process's. */
  cwd?: string;
  /** The catalogs to draw adapters from. Defaults to roots(cwd). Builtins always append. */
  catalogs?: Catalog[];
  /** The run's id, when the caller claimed one with runId() to know the run folder up front. */
  id?: string;
  /** The parent run's id. The engine sets it when it spawns a sub-run. */
  parent?: string;
  /**
   * Continue the run `id` names in its own folder. What the person answered and what
   * the agents returned replay from the run file; the world is read again.
   */
  resume?: boolean;
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
  if (options?.resume === true && options.id === undefined) {
    throw new PenguinError("resume needs the id of the run to continue");
  }
  const id = options?.id ?? runId();
  const journal = options?.resume === true ? openJournal(id, file, parsed) : undefined;
  const trace = createTrace(
    {
      id,
      workflow: file,
      params: parsed,
      cwd,
      root: projectRoot(cwd),
      parent: options?.parent,
      catalogs: options?.catalogs,
    },
    journal,
  );
  let children: Children | undefined;
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
      // An adapter a session names is probed when the session opens, not at preflight.
      installed.push(picked.found.definition as Adapter);
      const built =
        role === "agent"
          ? routeAgents(host, found, picked.found)
          : picked.found.definition.build(host);
      const traced = trace.wrap(role, built);
      // The view asks and the agent turns are how faults get handled, so wrapping
      // them in the same recovery would ask about the asking.
      if (role === "view") ctx[role] = settledStatus(traced as View);
      else if (role === "agent") ctx[role] = traced;
      else ctx[role] = rescue(role, traced);
    }
    children = childrenOf(trace, id, cwd, list);
    ctx[RUN] = children.hooks;
    // A child run works where its parent already checked, so only a root run pays for preflight.
    if (options?.parent === undefined) await preflight(installed, host, ctx);
    // The loader duck-typed the definition, so its schema's static type is gone here.
    const result = await definition.run(reached(ctx) as never);
    trace.note({ outcome: result ?? null });
    return result;
  } catch (error) {
    if (error instanceof RunPaused) {
      children?.pause();
      trace.note({ paused: pausedNote(error) });
    } else {
      trace.note({ threw: messageOf(error) });
    }
    throw error;
  }
}

function pausedNote(error: RunPaused): Entry {
  return {
    by: error.by,
    reason: error.message,
    ...(error.until === undefined ? {} : { until: error.until }),
  };
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

/** Every child run this process waits on, spawned or attached. Each leads its own group, so a signal names the group. */
const running = new Set<number>();

/** Passes a stop or a pause down to every running child, so this process never leaves work behind. */
export function signalChildren(signal: "SIGINT" | "SIGTERM"): void {
  for (const pid of running) {
    try {
      process.kill(-pid, signal);
    } catch {
      // already gone
    }
  }
}

type Children = {
  hooks: RunHooks;
  pause(): void;
};

function childrenOf(trace: Trace, parent: string, cwd: string, catalogs: Catalog[]): Children {
  let spawned = 0;
  const perform = async (job: Job, ordinal: number): Promise<unknown> => {
    const at = job.cwd ?? cwd;
    const child = childOf(parent, ordinal, { file: job.workflow, params: job.params, cwd: at });
    trace.note({ child: child.id, workflow: job.workflow });
    if (child.attach) return attached(job.workflow, child.id);
    const config: ChildJob = child.resume
      ? { id: child.id, resume: true }
      : { id: child.id, file: job.workflow, params: job.params, cwd: at, parent, catalogs };
    return spawnRun(job.workflow, config, at);
  };
  const wrapped = trace.wrapCall("run", perform);
  return {
    hooks: {
      spawn: (file, params, at) =>
        wrapped(
          at === undefined
            ? { workflow: file, params }
            : { workflow: file, params, cwd: path.resolve(cwd, at) },
          ++spawned,
        ),
    },
    pause: () => signalChildren("SIGINT"),
  };
}

type Placed = { id: string; resume: boolean; attach: boolean };

/**
 * The folder the nth child of a run works in. A run resumed after a pause finds the child it
 * had spawned there, still running or not, and continues it rather than starting another.
 */
function childOf(
  parent: string,
  ordinal: number,
  job: { file: string; params: unknown; cwd: string },
): Placed {
  const base = `${parent}-c${ordinal}`;
  for (let extra = 1; ; extra++) {
    const id = extra === 1 ? base : `${base}-${extra}`;
    const head = runHead(id);
    if (head === undefined) {
      fs.mkdirSync(runDir(id), { recursive: true });
      return { id, resume: false, attach: false };
    }
    const same =
      canonical(String(head["workflow"])) === canonical(job.file) &&
      JSON.stringify(head["params"]) === JSON.stringify(safe(job.params)) &&
      canonical(String(head["cwd"])) === canonical(job.cwd);
    if (!same) continue;
    const going = livePid(id) !== undefined && closingOf(id) === undefined;
    return { id, resume: !going, attach: going };
  }
}

/** One name for a path, whichever way a process wrote it: through a symlink or not. */
function canonical(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return file;
  }
}

type ChildJob =
  | { id: string; resume: true }
  | {
      id: string;
      file: string;
      params: unknown;
      cwd: string;
      parent: string;
      catalogs: Catalog[];
    };

/** Runs a child workflow as its own process and settles with the outcome its run file records. */
function spawnRun(workflow: string, job: ChildJob, cwd: string): Promise<unknown> {
  const entry = fileURLToPath(new URL("./child.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, JSON.stringify(job)], {
      cwd,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (child.pid !== undefined) running.add(child.pid);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (child.pid !== undefined) running.delete(child.pid);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (child.pid !== undefined) running.delete(child.pid);
      const said = stderr.trim() === "" ? "" : `: ${stderr.trim()}`;
      try {
        resolve(ended(workflow, closingOf(job.id), `died with ${signal ?? code}${said}`));
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Waits on a child whose process is still going, and settles with what it records. */
async function attached(workflow: string, id: string): Promise<unknown> {
  const pid = livePid(id);
  if (pid !== undefined) running.add(pid);
  try {
    for (;;) {
      const last = closingOf(id);
      if (last !== undefined || livePid(id) === undefined) {
        return ended(workflow, last, "died without a word");
      }
      await new Promise((wake) => setTimeout(wake, 250));
    }
  } finally {
    if (pid !== undefined) running.delete(pid);
  }
}

/** A child run's outcome, or the error its closing note stands for. */
function ended(workflow: string, last: Entry | undefined, died: string): unknown {
  const name = path.basename(workflow);
  if (last === undefined) throw new RunCrashed(`${name} ${died}`);
  if (last["stopped"] === true) throw new RunStopped(`${name} was stopped`);
  const paused = last["paused"];
  if (paused !== null && typeof paused === "object") {
    const note = paused as Record<string, unknown>;
    const reason = typeof note["reason"] === "string" ? note["reason"] : `${name} was paused`;
    throw new RunPaused(reason, {
      by: note["by"] === "limit" ? "limit" : "user",
      until: typeof note["until"] === "string" ? note["until"] : undefined,
    });
  }
  if ("outcome" in last) return last["outcome"];
  throw new PenguinError(String(last["threw"]));
}
