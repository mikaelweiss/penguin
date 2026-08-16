import type { z } from "zod";
import { WaError } from "./errors.ts";

export function usage(schema: z.ZodObject): string[] {
  const shape = schema.shape as Record<string, unknown>;
  return Object.entries(shape).map(([name, field]) => {
    const param = inspect(field);
    const token = param.kind === "boolean" ? `--${name}` : `--${name} <${placeholder(param)}>`;
    return param.optional ? `[${token}]` : token;
  });
}

export function parseParams(schema: z.ZodObject, argv: string[]): Record<string, unknown> {
  const shape = schema.shape as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--")) {
      throw new WaError(`params take the form --name value, got ${token}`);
    }
    let name = token.slice(2);
    let raw: string | undefined;
    const equals = name.indexOf("=");
    if (equals !== -1) {
      raw = name.slice(equals + 1);
      name = name.slice(0, equals);
    }
    let negated = false;
    if (raw === undefined && !(name in shape) && name.startsWith("no-") && name.slice(3) in shape) {
      negated = true;
      name = name.slice(3);
    }
    const field = shape[name];
    if (field === undefined) {
      const known = Object.keys(shape)
        .map((key) => `--${key}`)
        .join(" ");
      throw new WaError(`unknown param --${name}. This workflow takes: ${known || "no params"}`);
    }
    const kind = inspect(field).kind;
    if (raw === undefined) {
      if (kind === "boolean") {
        raw = negated ? "false" : "true";
      } else {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new WaError(`--${name} needs a value`);
        }
        raw = next;
        index += 1;
      }
    }
    values[name] = coerce(kind, name, raw);
    index += 1;
  }
  return values;
}

export function validate(schema: z.ZodObject, values: Record<string, unknown>): unknown {
  const checked = schema.safeParse(values);
  if (!checked.success) {
    const lines = checked.error.issues.map((issue) => {
      const at = issue.path.join(".");
      return at === "" ? `  ${issue.message}` : `  ${at}: ${issue.message}`;
    });
    throw new WaError(`invalid params:\n${lines.join("\n")}`);
  }
  return values;
}

function coerce(kind: string, name: string, raw: string): unknown {
  if (kind === "number") {
    const value = Number(raw);
    if (Number.isNaN(value)) throw new WaError(`--${name} needs a number, got ${raw}`);
    return value;
  }
  if (kind === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new WaError(`--${name} needs true or false, got ${raw}`);
  }
  return raw;
}

type Param = { kind: string; optional: boolean; choices: string[] };

type Def = {
  type?: string;
  innerType?: unknown;
  entries?: Record<string, unknown>;
  values?: unknown[];
};

const OPTIONAL = new Set(["optional", "default", "prefault", "catch"]);

function inspect(field: unknown): Param {
  let current = field as { _zod?: { def?: Def } };
  let optional = false;
  for (let depth = 0; depth < 16; depth += 1) {
    const def = current?._zod?.def;
    if (def === undefined) break;
    if (def.type !== undefined && OPTIONAL.has(def.type)) optional = true;
    if (def.innerType !== undefined) {
      current = def.innerType as typeof current;
      continue;
    }
    return { kind: def.type ?? "unknown", optional, choices: choicesOf(def) };
  }
  return { kind: "unknown", optional, choices: [] };
}

function choicesOf(def: Def): string[] {
  if (def.entries !== undefined) return Object.values(def.entries).map(String);
  if (Array.isArray(def.values)) return def.values.map(String);
  return [];
}

function placeholder(param: Param): string {
  if (param.choices.length > 0) return param.choices.join("|");
  if (param.kind === "number") return "number";
  if (param.kind === "string") return "text";
  return "value";
}
