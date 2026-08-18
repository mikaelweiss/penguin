import fs from "node:fs";
import { type RunRecord, readRun } from "./create.ts";
import { holder } from "./lock.ts";
import { eventsPath, runDir, runJsonPath, runsRoot, short } from "./paths.ts";
import type { ViewEvent } from "./types.ts";

export type LiveRow = {
  run: string;
  workflow: string;
  state: string;
  detail: string;
  age: string;
  dir: string;
};

/** Live runs only, for the piped `pn ps` table. */
export function liveRows(now: number): LiveRow[] {
  const root = runsRoot();
  if (!fs.existsSync(root)) return [];
  const names = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(runJsonPath(runDir(name))))
    .filter((name) => holder(runDir(name)) !== undefined);
  const collected = names.map((name) => liveRow(name, now));
  collected.sort((left, right) => left.run.localeCompare(right.run));
  return collected;
}

export const rows = liveRows;

export type RunOnDisk = {
  name: string;
  dir: string;
  workflow: string;
  cwd: string;
  live: boolean;
  createdAt: number;
};

/** Every run on disk, live ones first, each side ordered by name. */
export function runRows(): RunOnDisk[] {
  const root = runsRoot();
  if (!fs.existsSync(root)) return [];
  const found: RunOnDisk[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = runDir(entry.name);
    if (!fs.existsSync(runJsonPath(dir))) continue;
    let record: RunRecord;
    try {
      record = readRun(dir);
    } catch {
      continue;
    }
    found.push({
      name: entry.name,
      dir,
      workflow: short(record.workflow),
      cwd: startedIn(record),
      live: holder(dir) !== undefined,
      createdAt: Date.parse(record.createdAt),
    });
  }
  found.sort((left, right) => {
    if (left.live !== right.live) return left.live ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  return found;
}

function liveRow(name: string, now: number): LiveRow {
  const dir = runDir(name);
  const record = readRun(dir);
  const live = summary(dir);
  return {
    run: name,
    workflow: short(record.workflow),
    state: live.state,
    detail: cut(live.detail),
    age: age(now - Date.parse(record.createdAt)),
    dir: short(dir),
  };
}

function summary(dir: string): { state: string; detail: string } {
  let state = "running";
  let detail = "";
  let step = "";
  const file = eventsPath(dir);
  if (!fs.existsSync(file)) return { state, detail };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let event: ViewEvent;
    try {
      event = JSON.parse(line) as ViewEvent;
    } catch {
      continue;
    }
    if (event.type === "state") {
      state = event.state;
      detail = event.detail ?? "";
    }
    if (event.type === "step" && event.phase === "start") step = event.label;
  }
  return { state, detail: detail === "" && state === "running" ? step : detail };
}

function cut(text: string): string {
  const flat = text.replaceAll("\n", " ");
  if (flat === "") return "-";
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

function age(millis: number): string {
  const seconds = Math.max(0, Math.round(millis / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function startedIn(record: RunRecord): string {
  return typeof record.cwd === "string" && record.cwd !== "" ? record.cwd : process.cwd();
}
