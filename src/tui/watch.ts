import fs from "node:fs";
import { type RunRecord, readRun } from "../create.ts";
import { Tail } from "../follow.ts";
import { holder } from "../lock.ts";
import { eventsPath, runDir, runJsonPath, runsRoot, short } from "../paths.ts";
import { Projection } from "./projection.ts";

const TICK = 60;

export type RunRow = {
  name: string;
  dir: string;
  workflow: string;
  cwd: string;
  live: boolean;
  createdAt: number;
};

/** Every run on disk, live ones first, each side ordered by name. */
export function runRows(): RunRow[] {
  const root = runsRoot();
  if (!fs.existsSync(root)) return [];
  const rows: RunRow[] = [];
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
    rows.push({
      name: entry.name,
      dir,
      workflow: short(record.workflow),
      cwd: startedIn(record),
      live: holder(dir) !== undefined,
      createdAt: Date.parse(record.createdAt),
    });
  }
  rows.sort((left, right) => {
    if (left.live !== right.live) return left.live ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  return rows;
}

export function age(millis: number): string {
  const seconds = Math.max(0, Math.round(millis / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** The folder the run was started from, or this process's folder when the record says nothing. */
function startedIn(record: RunRecord): string {
  return typeof record.cwd === "string" && record.cwd !== "" ? record.cwd : process.cwd();
}

function cwdOf(dir: string): string {
  try {
    return startedIn(readRun(dir));
  } catch {
    return process.cwd();
  }
}

/**
 * One run's story, kept current. The projection is the only reader of event
 * semantics: this class hands it lines and tells the screen something changed.
 */
export class Feed {
  readonly name: string;
  readonly dir: string;
  readonly projection: Projection;
  private tail: Tail;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private changed = false;

  constructor(name: string, dir: string) {
    this.name = name;
    this.dir = dir;
    this.projection = new Projection(name, cwdOf(dir));
    this.tail = new Tail(eventsPath(dir), (line) => {
      this.projection.line(line);
      this.changed = true;
    });
  }

  /** The history so far. A second pass takes what landed while the first one read. */
  read(): void {
    this.tail.read();
    this.tail.read();
    this.changed = false;
  }

  follow(onChange: () => void): () => void {
    this.listeners.add(onChange);
    if (this.timer === undefined) {
      this.tail.follow();
      this.timer = setInterval(() => this.announce(), TICK);
      this.timer.unref();
    }
    return () => {
      this.listeners.delete(onChange);
    };
  }

  /** Read the file now and tell the listeners, outside the follow rhythm. */
  pump(): void {
    this.tail.read();
    this.announce();
  }

  stop(): void {
    this.tail.stop();
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }

  private announce(): void {
    if (!this.changed) return;
    this.changed = false;
    for (const listener of this.listeners) listener();
  }
}

/** The state a run row shows: what a live run is doing, or how a done one ended. */
export function stateOf(feed: Feed, live: boolean): { state: string; detail: string } {
  const reported = feed.projection.runState();
  if (feed.projection.phase() === "live" && !live) {
    return { state: "done", detail: "the run process died" };
  }
  return { state: reported.state, detail: reported.detail ?? "" };
}
