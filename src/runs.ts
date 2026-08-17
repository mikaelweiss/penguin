import fs from "node:fs";
import { readRun } from "./create.ts";
import { table } from "./layout.ts";
import { holder } from "./lock.ts";
import { eventsPath, runDir, runJsonPath, runsRoot, short } from "./paths.ts";
import type { ViewEvent } from "./types.ts";

export type Row = {
  run: string;
  workflow: string;
  state: string;
  detail: string;
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
    .filter((name) => fs.existsSync(runJsonPath(runDir(name))))
    .filter((name) => holder(runDir(name)) !== undefined);
  const collected = names.map((name) => row(name, now));
  collected.sort((left, right) => left.run.localeCompare(right.run));
  return collected;
}

export function render(list: Row[]): string {
  const columns: (keyof Row)[] = ["run", "workflow", "state", "detail", "age", "dir"];
  const header = ["RUN", "WORKFLOW", "STATE", "DETAIL", "AGE", "DIRECTORY"];
  return table([header, ...list.map((entry) => columns.map((column) => entry[column]))]);
}

function row(name: string, now: number): Row {
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
