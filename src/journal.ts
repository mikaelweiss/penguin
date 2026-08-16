import fs from "node:fs";
import path from "node:path";
import { WaError } from "./errors.ts";

export type Kind = "agent" | "session" | "adapter" | "gate";

export type StartEntry = {
  type: "start";
  workflow: string;
  cwd: string;
  params: unknown;
  createdAt: string;
};

export type CallEntry = {
  type: "call";
  id: string;
  kind: Kind;
  key: string;
  result: unknown;
};

export type GateEntry = {
  type: "gate";
  id: string;
  key: string;
  question: string;
};

export type ParkEntry = {
  type: "park";
  reason: string;
};

export type DoneEntry = {
  type: "done";
};

export type Entry = StartEntry | CallEntry | GateEntry | ParkEntry | DoneEntry;

export function journalPath(dir: string): string {
  return path.join(dir, "journal.jsonl");
}

export function read(dir: string): Entry[] {
  const file = journalPath(dir);
  if (!fs.existsSync(file)) throw new WaError(`no journal at ${file}`);
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Entry);
}

export function append(dir: string, entry: Entry): void {
  fs.appendFileSync(journalPath(dir), `${JSON.stringify(entry)}\n`);
}

export function startOf(entries: Entry[]): StartEntry {
  const first = entries[0];
  if (first === undefined || first.type !== "start") {
    throw new WaError("journal does not start with a start entry");
  }
  return first;
}

export function answersOf(entries: Entry[]): Map<string, CallEntry> {
  const answers = new Map<string, CallEntry>();
  for (const entry of entries) {
    if (entry.type === "call") answers.set(entry.id, entry);
  }
  return answers;
}

export function pendingGate(entries: Entry[]): GateEntry | undefined {
  const answers = answersOf(entries);
  let pending: GateEntry | undefined;
  for (const entry of entries) {
    if (entry.type === "gate" && !answers.has(entry.id)) pending = entry;
  }
  return pending;
}

export function lastPark(entries: Entry[]): ParkEntry | undefined {
  let park: ParkEntry | undefined;
  for (const entry of entries) {
    if (entry.type === "park") park = entry;
  }
  return park;
}

export function isDone(entries: Entry[]): boolean {
  return entries[entries.length - 1]?.type === "done";
}

export function lastCall(entries: Entry[]): CallEntry | undefined {
  let call: CallEntry | undefined;
  for (const entry of entries) {
    if (entry.type === "call") call = entry;
  }
  return call;
}
