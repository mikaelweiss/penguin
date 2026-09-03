import { bodyOf, linesOf } from "@/lib/attachments";
import type { Attachment } from "@/lib/attachments";

export type Control =
  | { kind: "text" }
  | { kind: "prose" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "choice"; choices: string[] }
  | { kind: "lines" }
  | { kind: "json" };

export type Param = {
  name: string;
  description: string | undefined;
  /** The workflow needs a value and names no default, so the form cannot send without one. */
  required: boolean;
  control: Control;
  initial: string | boolean;
};

export type Values = Record<string, string | boolean>;

type Schema = Record<string, unknown>;

function schemaOf(value: unknown): Schema | undefined {
  return value !== null && typeof value === "object" ? (value as Schema) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function controlOf(property: Schema): Control {
  const choices = property["enum"];
  if (Array.isArray(choices) && choices.every((choice) => typeof choice === "string")) {
    return { kind: "choice", choices };
  }
  const items = schemaOf(property["items"]);
  if (property["type"] === "array" && items?.["type"] === "string") return { kind: "lines" };
  if (property["type"] === "string") {
    return property["multiline"] === true ? { kind: "prose" } : { kind: "text" };
  }
  if (property["type"] === "number" || property["type"] === "integer") return { kind: "number" };
  if (property["type"] === "boolean") return { kind: "boolean" };
  return { kind: "json" };
}

function initialOf(control: Control, fallback: unknown): string | boolean {
  if (control.kind === "boolean") return fallback === true;
  if (fallback === undefined) return "";
  if (control.kind === "lines") {
    return Array.isArray(fallback) ? fallback.map(String).join("\n") : "";
  }
  return typeof fallback === "string" ? fallback : JSON.stringify(fallback);
}

/** The form a workflow's params schema asks a person for, one row per property it shows. */
export function paramsOf(schema: Record<string, unknown> | undefined): Param[] {
  const properties = schemaOf(schema?.["properties"]);
  if (properties === undefined) return [];
  const needed = schema?.["required"];
  const names = Array.isArray(needed) ? needed.map(String) : [];

  return Object.entries(properties).flatMap(([name, value]) => {
    const property = schemaOf(value);
    // An internal param is a caller's to fill, so the form neither shows it nor sends it.
    if (property === undefined || property["internal"] === true) return [];
    const control = controlOf(property);
    const fallback = property["default"];
    return [
      {
        name,
        description: text(property["description"]),
        required: names.includes(name) && fallback === undefined,
        control,
        initial: initialOf(control, fallback),
      },
    ];
  });
}

export function initialValues(params: Param[]): Values {
  return Object.fromEntries(params.map((param) => [param.name, param.initial]));
}

/** Prose is the one control a person writes sentences in; every other field holds an identifier. */
export function freeform(control: Control): boolean {
  return control.kind === "prose";
}

/** A pasted path reads as a value only where a line of text is one. */
export function canAttach(control: Control): boolean {
  return control.kind === "text" || control.kind === "prose" || control.kind === "lines";
}

/** The pasted paths ride the value, so no field ever shows a path a person did not type. */
export function withAttachments(
  params: Param[],
  values: Values,
  attachments: Record<string, Attachment[]>,
): Values {
  const merged: Values = { ...values };
  for (const param of params) {
    const files = attachments[param.name] ?? [];
    if (!canAttach(param.control) || files.length === 0) continue;
    const typed = values[param.name];
    const written = typeof typed === "string" ? typed : "";
    merged[param.name] =
      param.control.kind === "lines" ? linesOf(files, written) : bodyOf(files, written);
  }
  return merged;
}

export type Filled = { params: Record<string, unknown> } | { problems: Record<string, string> };

/** The typed params the form holds, or what each row that cannot be read is missing. */
export function fill(params: Param[], values: Values): Filled {
  const filled: Record<string, unknown> = {};
  const problems: Record<string, string> = {};

  for (const param of params) {
    const value = values[param.name];
    if (param.control.kind === "boolean") {
      filled[param.name] = value === true;
      continue;
    }
    const written = typeof value === "string" ? value.trim() : "";
    if (written === "") {
      if (param.required) problems[param.name] = "needs a value";
      continue;
    }
    const read = readValue(param.control, written, typeof value === "string" ? value : "");
    if ("problem" in read) problems[param.name] = read.problem;
    else filled[param.name] = read.value;
  }

  return Object.keys(problems).length > 0 ? { problems } : { params: filled };
}

function readValue(
  control: Control,
  written: string,
  raw: string,
): { value: unknown } | { problem: string } {
  if (control.kind === "number") {
    const value = Number(written);
    return Number.isNaN(value) ? { problem: "must be a number" } : { value };
  }
  if (control.kind === "lines") {
    const value = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    return value.length === 0 ? { problem: "needs a value" } : { value };
  }
  if (control.kind === "json") {
    try {
      return { value: JSON.parse(written) };
    } catch {
      return { problem: "must be JSON" };
    }
  }
  return { value: written };
}
