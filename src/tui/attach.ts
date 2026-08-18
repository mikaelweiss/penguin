import fs from "node:fs";
import * as adapters from "../adapters.ts";
import { readRun } from "../create.ts";
import { PenguinError } from "../errors.ts";
import { alive } from "../lock.ts";
import { eventsPath, runDir } from "../paths.ts";
import { plainAttach } from "./plain.ts";
import { interactive } from "./tty.ts";

const START_TIMEOUT = 10_000;

/** The announcement, on a full-width line: it carries the instruction that fixes the problem. */
export function agentLine(found: adapters.Found[]): string {
  const picked = adapters.pick(found, "agent");
  if ("found" in picked) return `agent ${picked.found.name}`;
  return "conflict" in picked ? picked.conflict : picked.missing;
}

/** The run view header, cut to the tree pane. Only a short label survives it. */
export function agentLabel(found: adapters.Found[]): string {
  const picked = adapters.pick(found, "agent");
  if ("found" in picked) return `agent ${picked.found.name}`;
  if (!found.some((entry) => entry.role === "agent")) return "no agent adapter";
  return "conflict" in picked ? "agent: choose one" : "agent: default missing";
}

/** Watch one run: the full screen on a terminal, plain lines anywhere else. */
export async function attach(name: string, pid?: number): Promise<number> {
  const dir = runDir(name);
  if (!fs.existsSync(dir)) throw new PenguinError(`no run named ${name}`);
  const record = readRun(dir);
  const found = await adapters.installed(record.cwd);
  if (pid !== undefined && !(await started(dir, pid))) {
    process.stderr.write(`pn: the run process for ${name} died before it started\n`);
    return 1;
  }
  if (!interactive()) return plainAttach(name, dir, agentLine(found));
  const { mount } = await import("./app.tsx");
  return mount({ kind: "run", name, agent: agentLabel(found) });
}

/** The dashboard: the live runs, the done ones under `d`, and everything waiting on the user. */
export async function dashboard(): Promise<number> {
  const { mount } = await import("./app.tsx");
  return mount({ kind: "dashboard" });
}

/** True once the run process holds the run. A viewer that opens earlier reads it as dead. */
export function started(dir: string, pid: number): Promise<boolean> {
  const deadline = Date.now() + START_TIMEOUT;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (fs.existsSync(eventsPath(dir))) return resolve(true);
      if (!alive(pid)) return resolve(false);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 30);
    };
    tick();
  });
}
