import type { z } from "zod";
import { WaError } from "./errors.ts";

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
    const kind = baseType(field);
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

function baseType(field: unknown): string {
  let current = field as { _zod?: { def?: { type?: string; innerType?: unknown } } };
  for (let depth = 0; depth < 16; depth += 1) {
    const def = current?._zod?.def;
    if (def === undefined) return "unknown";
    if (def.innerType !== undefined) {
      current = def.innerType as typeof current;
      continue;
    }
    return def.type ?? "unknown";
  }
  return "unknown";
}
