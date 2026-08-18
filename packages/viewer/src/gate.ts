export type GateControl = { list: string[]; many: boolean } | { hint: string | undefined };

/** The control a gate's answer shape draws, or the hint the free input shows. */
export function controlFor(schema: Record<string, unknown>): GateControl {
  const labels = enumOf(schema);
  if (labels !== undefined) return { list: labels, many: false };
  if (schema["type"] === "array") {
    const items = enumOf(schema["items"]);
    if (items !== undefined) return { list: items, many: true };
  }
  if (schema["type"] === "boolean") return { list: ["yes", "no"], many: false };
  const open = optionsOf(schema);
  if (open !== undefined) return { list: open, many: false };
  return { hint: hintOf(schema) };
}

/** The options of a shape that names them beside any other string. */
function optionsOf(schema: Record<string, unknown>): string[] | undefined {
  const branches = schema["anyOf"];
  if (!Array.isArray(branches) || branches.length !== 2) return undefined;
  const named = branches.map((branch) => enumOf(branch));
  const at = named.findIndex((labels) => labels !== undefined);
  if (at === -1) return undefined;
  return anyString(branches[1 - at]) ? named[at] : undefined;
}

function anyString(schema: unknown): boolean {
  if (schema === null || typeof schema !== "object") return false;
  const one = schema as Record<string, unknown>;
  return one["type"] === "string" && one["enum"] === undefined;
}

function enumOf(schema: unknown): string[] | undefined {
  if (schema === null || typeof schema !== "object") return undefined;
  const values = (schema as { enum?: unknown }).enum;
  if (!Array.isArray(values) || values.length === 0) return undefined;
  if (values.some((value) => typeof value !== "string")) return undefined;
  return values as string[];
}

function hintOf(schema: Record<string, unknown>): string | undefined {
  const format = schema["format"];
  if (typeof format === "string") return format === "uri" ? "url" : format;
  const type = schema["type"];
  return typeof type === "string" ? type : undefined;
}
