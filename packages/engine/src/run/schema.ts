import { z } from "zod";

/** Apply the schemas authors write to gates and agent turns. Zod stays in this file. */

/** A workflow params object, or a turn result / blocked envelope. Authors write these. */
export type ObjectSchema = z.ZodObject;

/** A gate shape, or any other author schema the engine applies. */
export type AnySchema = z.ZodType;

type TurnSchemas = { result?: ObjectSchema; blocked?: ObjectSchema };

export function envelopeOf(call: TurnSchemas): AnySchema | undefined {
  if (call.result === undefined) return undefined;
  if (call.blocked === undefined) return call.result;
  return z.union([z.strictObject({ result: call.result }), z.strictObject({ blocked: call.blocked })]);
}

export function jsonSchema(shape: AnySchema): Record<string, unknown> {
  const schema = z.toJSONSchema(shape) as Record<string, unknown>;
  delete schema["$schema"];
  return schema;
}

/** An agent CLI turns the schema into a tool schema, and a tool schema takes no union at its top level. */
export function turnSchema(call: TurnSchemas): Record<string, unknown> | undefined {
  if (call.result === undefined) return undefined;
  if (call.blocked === undefined) return jsonSchema(call.result);
  return jsonSchema(
    z.object({
      result: call.result.optional().describe("fill this or blocked, and never both"),
      blocked: call.blocked.optional().describe("fill this or result, and never both"),
    }),
  );
}

export function parseAnswer(shape: AnySchema, text: string): { value: unknown } | { problem: string } {
  let problem = "";
  for (const candidate of candidates(text)) {
    const checked = shape.safeParse(candidate);
    if (checked.success) return { value: checked.data };
    if (problem === "") problem = schemaIssues(checked.error);
  }
  return { problem };
}

function candidates(text: string): unknown[] {
  const trimmed = text.trim();
  const list: unknown[] = [trimmed, text];
  const asNumber = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(asNumber)) list.push(asNumber);
  const lowered = trimmed.toLowerCase();
  if (["yes", "y", "true"].includes(lowered)) list.push(true);
  if (["no", "n", "false"].includes(lowered)) list.push(false);
  if (text.includes(",")) list.push(trimmed.split(",").map((part) => part.trim()));
  list.push([trimmed]);
  const json = asJson(text);
  if (json !== undefined) list.push(json);
  return list;
}

function asJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function schemaIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.join(".");
      return at === "" ? issue.message : `${at}: ${issue.message}`;
    })
    .join("; ");
}
