import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { messageOf, PenguinError } from "./core/errors.ts";
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
  parent?: string | undefined;
};

type Entry = Record<string, unknown>;

/** A JSON-safe copy: functions named, zod shapes as JSON Schema, the unserializable admitted. */
function safe(value: unknown): unknown {
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

/** The newest run file, for run's resume option. */
export function latestRun(): string | undefined {
  const dir = runsDir();
  if (!fs.existsSync(dir)) return undefined;
  const last = fs
    .readdirSync(dir)
    .map((name) => path.join(dir, name, "run.jsonl"))
    .filter((file) => fs.existsSync(file))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
    .at(-1);
  return last;
}

/** Reads a run file back as a journal of calls, refusing one from another workflow or params. */
export function openJournal(file: string, workflow: string, params: unknown): Entry[] {
  const entries = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Entry);
  const head = entries.find((entry) => "workflow" in entry && "params" in entry);
  const same =
    head !== undefined &&
    head["workflow"] === workflow &&
    JSON.stringify(head["params"]) === JSON.stringify(safe(params));
  if (!same) throw new PenguinError(`${file} is not a run of this workflow and params`);
  return entries.filter((entry) => typeof entry["call"] === "string" && entry["pending"] !== true);
}

export function createTrace(info: RunInfo, journal?: Entry[]): Trace {
  const dir = runDir(info.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "run.jsonl");
  const inbox = path.join(dir, "inbox.jsonl");
  if (!fs.existsSync(inbox)) fs.writeFileSync(inbox, "");
  const ahead = journal ?? [];
  let index = 0;
  let live = journal === undefined;
  let seq = 0;

  const append = (entry: Entry): void => {
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  };

  append({
    at: new Date().toISOString(),
    run: info.id,
    pid: process.pid,
    workflow: info.workflow,
    params: safe(info.params),
    cwd: info.cwd,
    ...(info.parent === undefined ? {} : { parent: info.parent }),
  });

  const note = (entry: Entry): void => {
    const cleaned: Entry = { at: new Date().toISOString() };
    for (const [key, value] of Object.entries(entry)) cleaned[key] = safe(value);
    append(cleaned);
  };

  /** The next journal entry, when it recorded this exact call completing with a plain value. */
  function recorded(name: string, args: unknown): Entry | undefined {
    const entry = ahead[index];
    const match =
      entry !== undefined &&
      entry["call"] === name &&
      JSON.stringify(entry["args"]) === JSON.stringify(args) &&
      entry["threw"] === undefined &&
      entry["handle"] === undefined;
    if (!match) return undefined;
    index++;
    return entry;
  }

  function wrapFunction(name: string, fn: (...args: unknown[]) => unknown, self: unknown) {
    return (...args: unknown[]): unknown => {
      const argsSafe = safe(args);
      if (!live) {
        const entry = recorded(name, argsSafe);
        if (entry !== undefined) {
          append({
            at: new Date().toISOString(),
            call: name,
            args: argsSafe,
            outcome: entry["outcome"],
            sync: entry["sync"],
            replayed: true,
          });
          return entry["sync"] === true ? entry["outcome"] : Promise.resolve(entry["outcome"]);
        }
        live = true;
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
            append({ ...called, id, elapsedMs: elapsed(), outcome: safe(value) });
            return value;
          },
          (error: unknown) => {
            append({ ...called, id, elapsedMs: elapsed(), threw: messageOf(error) });
            throw error;
          },
        );
      }
      const handle = typeof result === "object" && result !== null;
      if (handle) append({ ...called, elapsedMs: elapsed(), sync: true, handle: true });
      else append({ ...called, elapsedMs: elapsed(), sync: true, outcome: safe(result) });
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
