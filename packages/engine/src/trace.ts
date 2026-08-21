import fs from "node:fs";
import path from "node:path";
import { messageOf } from "./core/errors.ts";
import { tracesDir } from "./paths.ts";

export type Trace = {
  file: string;
  note(entry: Record<string, unknown>): void;
  wrap<A>(role: string, api: A): A;
};

const LIMIT = 200;

/** A JSON-safe copy: functions named, long strings cut, the unserializable admitted. */
function safe(value: unknown): unknown {
  try {
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "function") return "[function]";
      if (typeof item === "string" && item.length > LIMIT) return `${item.slice(0, LIMIT)}...`;
      return item;
    });
    return text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return "[unserializable]";
  }
}

export function createTrace(): Trace {
  fs.mkdirSync(tracesDir(), { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const file = path.join(tracesDir(), `${stamp}-${process.pid}.jsonl`);

  const append = (entry: Record<string, unknown>): void => {
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  };

  const note = (entry: Record<string, unknown>): void => {
    const cleaned: Record<string, unknown> = { at: new Date().toISOString() };
    for (const [key, value] of Object.entries(entry)) cleaned[key] = safe(value);
    append(cleaned);
  };

  function wrapFunction(name: string, fn: (...args: unknown[]) => unknown, self: unknown) {
    return (...args: unknown[]): unknown => {
      const called: Record<string, unknown> = {
        at: new Date().toISOString(),
        call: name,
        args: safe(args),
      };
      let result: unknown;
      try {
        result = fn.apply(self, args);
      } catch (error) {
        append({ ...called, threw: messageOf(error) });
        throw error;
      }
      if (result instanceof Promise) {
        return result.then(
          (value) => {
            append({ ...called, outcome: safe(value) });
            return value;
          },
          (error: unknown) => {
            append({ ...called, threw: messageOf(error) });
            throw error;
          },
        );
      }
      const handle = typeof result === "object" && result !== null;
      append({ ...called, outcome: handle ? "[handle]" : safe(result) });
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
    note,
    wrap: <A>(role: string, api: A): A => wrapApi(role, api) as A,
  };
}
