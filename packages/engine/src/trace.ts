import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { messageOf, PenguinError } from "./core/errors.ts";
import { isClosing, isHead, lastSegment, type Entry } from "./core/segments.ts";
import { runDir, runsDir } from "./paths.ts";

export type Trace = {
  file: string;
  dir: string;
  note(entry: Record<string, unknown>): void;
  wrap<A>(role: string, api: A): A;
  wrapCall<Args extends unknown[], R>(
    name: string,
    fn: (...args: Args) => Promise<R>,
  ): (...args: Args) => Promise<R>;
};

export type RunInfo = {
  id: string;
  workflow: string;
  params: unknown;
  cwd: string;
  /** The git project's root, how frontends group worktree runs under their project. */
  root: string;
  parent?: string | undefined;
  /** The catalogs a parent handed this run. A root run finds its own. */
  catalogs?: unknown;
};

export type { Entry } from "./core/segments.ts";

/** What a resumed run replays: the settled calls of the last segment, and the call ids already used. */
export type Journal = { calls: Entry[]; issued: number };

/** A JSON-safe copy: functions named, zod shapes as JSON Schema, the unserializable admitted. */
export function safe(value: unknown): unknown {
  try {
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "function") return "[function]";
      if (item !== null && typeof item === "object" && "_zod" in item) {
        try {
          return z.toJSONSchema(item as z.ZodType);
        } catch {
          return "[shape]";
        }
      }
      return item;
    });
    return text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return "[unserializable]";
  }
}

/** A fresh run id, its folder claimed under <state>/runs. */
export function runId(): string {
  fs.mkdirSync(runsDir(), { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  let id = `${stamp}-${process.pid}`;
  for (let extra = 2; fs.existsSync(runDir(id)); extra++) {
    id = `${stamp}-${process.pid}-${extra}`;
  }
  fs.mkdirSync(runDir(id));
  return id;
}

export function runFile(id: string): string {
  return path.join(runDir(id), "run.jsonl");
}

export function readEntries(file: string): Entry[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Entry);
}

/** The run's first head: how it was started. */
export function runHead(id: string): Entry | undefined {
  return readEntries(runFile(id)).find(isHead);
}

/** How the run's latest segment ended, undefined while it has not. */
export function closingOf(id: string): Entry | undefined {
  return lastSegment(readEntries(runFile(id))).findLast(isClosing);
}

/** The process that last wrote the run, undefined once it is gone. */
export function livePid(id: string): number | undefined {
  let pid: number;
  try {
    pid = Number(fs.readFileSync(path.join(runDir(id), "pid"), "utf8"));
  } catch {
    return undefined;
  }
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

/** The run file's calls that stood for the person and the agents: what a resume replays. */
export function remembered(name: string): boolean {
  return name === "run" || name === "view.ask" || name.startsWith("agent.");
}

function issuedIn(entries: Entry[]): number {
  let highest = 0;
  for (const entry of entries) {
    const id = entry["id"];
    if (typeof id !== "string" || !id.startsWith("c")) continue;
    const number = Number(id.slice(1));
    if (Number.isInteger(number) && number > highest) highest = number;
  }
  return highest;
}

function replayable(entry: Entry): boolean {
  return (
    typeof entry["call"] === "string" &&
    remembered(entry["call"]) &&
    entry["pending"] !== true &&
    entry["threw"] === undefined &&
    "outcome" in entry
  );
}

/**
 * The replayable calls of the newest segment that recorded any. A segment that ran live wrote
 * down what it replayed, so it holds everything before it; one that died in setup holds nothing
 * and must not hide the segment before it.
 */
function journaled(entries: Entry[]): Entry[] {
  let end = entries.length;
  for (;;) {
    const opened = entries.slice(0, end).findLastIndex(isHead);
    const calls = entries.slice(opened + 1, end).filter(replayable);
    if (calls.length > 0 || opened <= 0) return calls;
    end = opened;
  }
}

/**
 * Reads a run's file back to resume it, refusing another workflow's run, other
 * params, or a run whose process is still writing.
 */
export function openJournal(id: string, workflow: string, params: unknown): Journal {
  const file = runFile(id);
  const entries = readEntries(file);
  const head = entries.findLast(isHead);
  const same =
    head !== undefined &&
    head["workflow"] === workflow &&
    JSON.stringify(head["params"]) === JSON.stringify(safe(params));
  if (!same) throw new PenguinError(`${file} is not a run of this workflow and params`);
  if (livePid(id) !== undefined && lastSegment(entries).findLast(isClosing) === undefined) {
    throw new PenguinError(`${id} is still running`);
  }
  return { calls: journaled(entries), issued: issuedIn(entries) };
}

async function* nothing(): AsyncGenerator<never> {}

function isStream(value: unknown): boolean {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

function replayedHandle(entry: Entry): Record<string, unknown> {
  const streams = Array.isArray(entry["streams"]) ? (entry["streams"] as string[]) : [];
  const handle: Record<string, unknown> = { value: Promise.resolve(entry["outcome"]) };
  for (const name of streams) handle[name] = nothing();
  return handle;
}

export function createTrace(info: RunInfo, journal?: Journal): Trace {
  const dir = runDir(info.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "run.jsonl");
  const inbox = path.join(dir, "inbox.jsonl");
  if (!fs.existsSync(inbox)) fs.writeFileSync(inbox, "");
  fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
  const ahead = journal?.calls ?? [];
  let index = 0;
  let live = journal === undefined;
  let seq = journal?.issued ?? 0;

  const append = (entry: Entry): void => {
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  };

  append({
    at: new Date().toISOString(),
    run: info.id,
    workflow: info.workflow,
    params: safe(info.params),
    cwd: info.cwd,
    root: info.root,
    ...(info.parent === undefined ? {} : { parent: info.parent }),
    ...(info.catalogs === undefined ? {} : { catalogs: safe(info.catalogs) }),
  });

  const note = (entry: Entry): void => {
    const cleaned: Entry = { at: new Date().toISOString() };
    for (const [key, value] of Object.entries(entry)) cleaned[key] = safe(value);
    append(cleaned);
  };

  /** The next journal entry, when it is this exact call. Any other call ends the replay. */
  function recorded(name: string, args: unknown): Entry | undefined {
    const entry = ahead[index];
    const match =
      entry !== undefined &&
      entry["call"] === name &&
      JSON.stringify(entry["args"]) === JSON.stringify(args);
    if (!match) {
      live = true;
      return undefined;
    }
    index++;
    return entry;
  }

  function replay(entry: Entry, name: string, args: unknown): unknown {
    append({
      at: new Date().toISOString(),
      call: name,
      args,
      outcome: entry["outcome"],
      replayed: true,
      ...(entry["sync"] === true ? { sync: true } : {}),
      ...(entry["handle"] === true ? { handle: true } : {}),
    });
    if (entry["handle"] === true) return replayedHandle(entry);
    return entry["sync"] === true ? entry["outcome"] : Promise.resolve(entry["outcome"]);
  }

  function wrapFunction(name: string, fn: (...args: unknown[]) => unknown, self: unknown) {
    return (...args: unknown[]): unknown => {
      const argsSafe = safe(args);
      if (!live && remembered(name)) {
        const entry = recorded(name, argsSafe);
        if (entry !== undefined) return replay(entry, name, argsSafe);
      }
      const called: Entry = { at: new Date().toISOString(), call: name, args: argsSafe };
      const startedMs = Date.now();
      const elapsed = (): number => Date.now() - startedMs;
      let result: unknown;
      try {
        result = fn.apply(self, args);
      } catch (error) {
        append({ ...called, elapsedMs: elapsed(), threw: messageOf(error) });
        throw error;
      }
      if (result instanceof Promise) {
        const id = `c${++seq}`;
        append({ ...called, id, pending: true });
        return result.then(
          (value) => {
            append({ ...called, id, elapsedMs: elapsed(), outcome: safe(value) ?? null });
            return value;
          },
          (error: unknown) => {
            append({ ...called, id, elapsedMs: elapsed(), threw: messageOf(error) });
            throw error;
          },
        );
      }
      if (typeof result !== "object" || result === null) {
        append({ ...called, elapsedMs: elapsed(), sync: true, outcome: safe(result) ?? null });
        return result;
      }
      const value = (result as Record<string, unknown>)["value"];
      if (!(value instanceof Promise)) {
        append({ ...called, elapsedMs: elapsed(), sync: true, handle: true });
        return result;
      }
      const id = `c${++seq}`;
      const streams = Object.keys(result).filter((key) =>
        isStream((result as Record<string, unknown>)[key]),
      );
      const opened: Entry = { ...called, id, handle: true, streams };
      append({ ...opened, pending: true });
      value.then(
        (settled) => append({ ...opened, elapsedMs: elapsed(), outcome: safe(settled) ?? null }),
        (error: unknown) => append({ ...opened, elapsedMs: elapsed(), threw: messageOf(error) }),
      );
      return result;
    };
  }

  function wrapApi(prefix: string, api: unknown): unknown {
    if (api === null || typeof api !== "object") return api;
    const wrapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(api)) {
      const name = `${prefix}.${key}`;
      if (typeof value === "function") {
        wrapped[key] = wrapFunction(name, value as (...args: unknown[]) => unknown, api);
      } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        wrapped[key] = wrapApi(name, value);
      } else {
        wrapped[key] = value;
      }
    }
    return wrapped;
  }

  return {
    file,
    dir,
    note,
    wrap: <A>(role: string, api: A): A => wrapApi(role, api) as A,
    wrapCall: (name, fn) =>
      wrapFunction(name, fn as (...args: unknown[]) => unknown, undefined) as typeof fn,
  };
}
