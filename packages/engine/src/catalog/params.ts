import { PenguinError } from "../errors.ts";

/** What the CLI needs from a workflow params schema. Authors still write z.object. */
export type ParamsSchema = {
  shape: Record<string, unknown>;
  parse(data: unknown): unknown;
  safeParse(data: unknown): {
    success: true;
    data: unknown;
  } | {
    success: false;
    error: { issues: { path: PropertyKey[]; message: string }[] };
  };
};

export function usage(schema: ParamsSchema): string[] {
  const shape = schema.shape as Record<string, unknown>;
  return Object.entries(shape).map(([name, field]) => {
    const param = inspect(field);
    const token = param.kind === "boolean" ? `--${name}` : `--${name} <${placeholder(param)}>`;
    return param.optional ? `[${token}]` : token;
  });
}

export function parseParams(schema: ParamsSchema, argv: string[]): Record<string, unknown> {
  const shape = schema.shape as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  const ordered = Object.entries(shape)
    .filter(([, field]) => inspect(field).kind !== "boolean")
    .map(([name]) => name);
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--")) {
      const open = ordered.find((key) => !(key in values));
      if (open === undefined) {
        const takes = ordered.length === 0 ? "no params by position" : `only ${ordered.join(", ")}`;
        throw new PenguinError(`nothing left to fill with ${token}. This workflow takes ${takes}`);
      }
      values[open] = coerce(inspect(shape[open]).kind, open, token);
      index += 1;
      continue;
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
      throw new PenguinError(`unknown param --${name}. This workflow takes: ${known || "no params"}`);
    }
    const kind = inspect(field).kind;
    if (raw === undefined) {
      if (kind === "boolean") {
        raw = negated ? "false" : "true";
      } else {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new PenguinError(`--${name} needs a value`);
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

export function validate(schema: ParamsSchema, values: Record<string, unknown>): unknown {
  const checked = schema.safeParse(values);
  if (!checked.success) {
    const lines = checked.error.issues.map((issue) => {
      const at = issue.path.join(".");
      return at === "" ? `  ${issue.message}` : `  ${at}: ${issue.message}`;
    });
    throw new PenguinError(`invalid params:\n${lines.join("\n")}`);
  }
  return values;
}

export type Asked = { name: string; kind: string; optional: boolean; choices: string[]; hint: string };

/** The non-boolean params nothing has filled, in the order the schema declares them. */
export function unfilled(schema: ParamsSchema, values: Record<string, unknown>): Asked[] {
  const shape = schema.shape as Record<string, unknown>;
  return Object.entries(shape)
    .filter(([name]) => !(name in values))
    .map(([name, field]) => ({ name, param: inspect(field) }))
    .filter(({ param }) => param.kind !== "boolean")
    .map(({ name, param }) => ({
      name,
      kind: param.kind,
      optional: param.optional,
      choices: param.choices,
      hint: placeholder(param),
    }));
}

export function coerce(kind: string, name: string, raw: string): unknown {
  if (kind === "number") {
    const value = Number(raw);
    if (Number.isNaN(value)) throw new PenguinError(`--${name} needs a number, got ${raw}`);
    return value;
  }
  if (kind === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new PenguinError(`--${name} needs true or false, got ${raw}`);
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
