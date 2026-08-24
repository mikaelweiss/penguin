import { z } from "zod";

export type Message = { text: string };

export type ShowOptions = {
  /**
   * "tool" marks an agent's action line. Frontends render it dimmer and feed the activity line.
   * "waiting" says the run idles on an outside event until it shows anything else.
   */
  kind?: "tool" | "waiting";
};

export type Ask = {
  (question: string): Promise<string>;
  <Shape extends z.ZodType>(question: string, shape: Shape): Promise<z.infer<Shape>>;
};

/** The one way a workflow reaches the person watching. */
export type View = {
  show(text: string, options?: ShowOptions): Promise<void>;
  ask: Ask;
  listen(): AsyncIterable<Message>;
};

export type Choice = { label: string; value: unknown };

export type Menu = {
  choices: Choice[];
  /** Free text is also an answer. */
  other: boolean;
  /** More than one choice can be picked; the answer is an array. */
  many: boolean;
};

/** The choices a shape names: booleans, enums, literals, unions of those with free text, and arrays of those. */
export function menuOf(shape: z.ZodType): Menu | undefined {
  try {
    return menuOfSchema(z.toJSONSchema(shape) as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

/** The same mapping from a JSON Schema, for a frontend reading an ask out of a run file. */
export function menuOfSchema(schema: Record<string, unknown>): Menu | undefined {
  if (schema["type"] === "boolean") {
    return {
      choices: [
        { label: "yes", value: true },
        { label: "no", value: false },
      ],
      other: false,
      many: false,
    };
  }
  if (schema["type"] === "array") {
    const items = schema["items"];
    if (items === null || typeof items !== "object") return undefined;
    const inner = menuOfSchema(items as Record<string, unknown>);
    if (inner === undefined || inner.other || inner.many) return undefined;
    return { ...inner, many: true };
  }
  const named = schema["enum"] ?? (schema["const"] === undefined ? undefined : [schema["const"]]);
  if (Array.isArray(named)) {
    return {
      choices: named.map((value) => ({ label: String(value), value })),
      other: false,
      many: false,
    };
  }
  if (Array.isArray(schema["anyOf"])) {
    const choices: Choice[] = [];
    let other = false;
    for (const member of schema["anyOf"] as Record<string, unknown>[]) {
      const sub = menuOfSchema(member);
      if (sub !== undefined && !sub.many) {
        choices.push(...sub.choices);
        other = other || sub.other;
      } else if (member["type"] === "string") {
        other = true;
      } else {
        return undefined;
      }
    }
    return choices.length === 0 ? undefined : { choices, other, many: false };
  }
  return undefined;
}

/** A person types text. JSON is how they type a number, list, or object. */
export function candidates(raw: unknown): unknown[] {
  if (typeof raw !== "string") return [raw];
  const list: unknown[] = [raw];
  try {
    list.push(JSON.parse(raw));
  } catch {
    // not JSON, the raw text stands alone
  }
  return list;
}
