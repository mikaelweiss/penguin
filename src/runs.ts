import fs from "node:fs";
import * as journal from "./journal.ts";
import { table } from "./layout.ts";
import { holder } from "./lock.ts";
import { runDir, runsRoot, short } from "./paths.ts";

export type Row = {
  run: string;
  workflow: string;
  state: string;
  step: string;
  age: string;
  dir: string;
};

export function rows(now: number): Row[] {
  const root = runsRoot();
  if (!fs.existsSync(root)) return [];
  const names = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(journal.journalPath(runDir(name))));
  const collected = names.map((name) => row(name, now));
  collected.sort((left, right) => left.run.localeCompare(right.run));
  return collected;
}

export function render(list: Row[]): string {
  const columns: (keyof Row)[] = ["run", "workflow", "state", "step", "age", "dir"];
  const header = ["RUN", "WORKFLOW", "STATE", "STEP", "AGE", "DIRECTORY"];
  return table([header, ...list.map((entry) => columns.map((column) => entry[column]))]);
}

function row(name: string, now: number): Row {
  const dir = runDir(name);
  const entries = journal.read(dir);
  const start = journal.startOf(entries);
  const done = journal.isDone(entries);
  const pid = holder(dir);
  const state = pid !== undefined ? `running (${pid})` : done ? "done" : "parked";
  return {
    run: name,
    workflow: short(start.workflow),
    state,
    step: done ? "-" : detail(entries),
    age: age(now - Date.parse(start.createdAt)),
    dir: short(dir),
  };
}

function detail(entries: journal.Entry[]): string {
  const gate = journal.pendingGate(entries);
  if (gate !== undefined) return cut(`gate: ${gate.question}`);
  const park = journal.lastPark(entries);
  if (park !== undefined) return cut(park.reason);
  const call = journal.lastCall(entries);
  if (call !== undefined) return cut(`${call.kind} ${target(call.key)}`);
  return "-";
}

function target(key: string): string {
  const parsed = JSON.parse(key) as {
    role?: string;
    method?: string;
    skill?: string;
    question?: string;
    use?: string;
  };
  if (parsed.skill !== undefined) return parsed.skill;
  if (parsed.role !== undefined && parsed.method !== undefined) {
    return `${parsed.role}.${parsed.method}`;
  }
  if (parsed.question !== undefined) return parsed.question;
  if (parsed.use !== undefined) return parsed.use;
  return key;
}

function cut(text: string): string {
  const flat = text.replaceAll("\n", " ");
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
