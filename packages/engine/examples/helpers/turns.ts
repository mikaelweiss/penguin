import crypto from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import {
  Channel,
  issuesOf,
  PenguinError,
  type Action,
  type Host,
  type Skill,
  type View,
} from "penguin";

export type Chunk = { kind: "text" | "thinking"; text: string } | { kind: "tool"; call: Action };

/** What a turn runs on: a catalog skill with an optional prompt for the dynamic part, or a prompt alone. */
export type TurnAsk = string | { skill: string; prompt?: string };

export type Turn<T> = { output: AsyncIterable<Chunk>; value: Promise<T> };

export type Attempt = { ok: true; value: unknown } | { ok: false; error: string };

export type TurnFn = {
  (session: string, ask: TurnAsk): Turn<null>;
  <Shape extends z.ZodObject>(
    session: string,
    ask: TurnAsk,
    options: { result: Shape },
  ): Turn<z.infer<Shape>>;
};

export type AgentApi<Options> = {
  open(options?: Options): Promise<string>;
  turn: TurnFn;
  /** Ends the running turn. The session stays open for the next one. */
  stop(session: string): Promise<void>;
};

export type Invocation<Options> = {
  session: string;
  first: boolean;
  options: Options;
  prompt: string;
  schema: Record<string, unknown> | undefined;
  signal: AbortSignal;
};

/** One CLI invocation: stream what the agent does through emit, return how it ended. */
export type RunOnce<Options> = (
  invocation: Invocation<Options>,
  emit: (chunk: Chunk) => void,
) => Promise<Attempt>;

export function jsonSchema(shape: z.ZodObject): Record<string, unknown> {
  const schema = z.toJSONSchema(shape) as Record<string, unknown>;
  delete schema["$schema"];
  return schema;
}

/** The skill's instructions, where its files live when it has any, then the prompt. */
function withSkill(skill: Skill, prompt: string | undefined): string {
  const parts = [skill.text];
  const extras = fs.readdirSync(skill.dir).filter((name) => name !== "SKILL.md");
  if (extras.length > 0) parts.push(`This skill's files live in ${skill.dir}.`);
  if (prompt !== undefined && prompt.trim() !== "") parts.push(prompt);
  return parts.join("\n\n");
}

export function said(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Caps a tool output so a chatty call cannot flood the run file. */
export function clip(text: string, limit = 4000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… ${text.length - limit} more characters`;
}

/** The one value that says what a tool call acts on, read off the fields the CLI is known to use. */
export function targetIn(fields: string[]): (input: unknown) => string | undefined {
  return (input) => {
    if (input === null || typeof input !== "object") return undefined;
    const values = input as Record<string, unknown>;
    const named = fields.map((field) => values[field]).find(said);
    if (named !== undefined) return flatten(named);
    const first = Object.values(values).find(said);
    return first === undefined ? undefined : flatten(first);
  };
}

/**
 * The session machinery every agent adapter shares: open handles, run a turn
 * with one corrected retry, validate a typed result, and stop mid-flight.
 * The adapter supplies runOnce, the one CLI invocation.
 */
export function sessions<Options>(host: Host, runOnce: RunOnce<Options>): AgentApi<Options> {
  const opened = new Map<string, Options>();
  const started = new Set<string>();
  const running = new Map<string, AbortController>();
  const stopped = new Set<string>();

  const turn = ((session: string, ask: TurnAsk, options?: { result?: z.ZodObject }) => {
    const settings = opened.get(session);
    if (settings === undefined) {
      throw new PenguinError(`no open session ${session}. ctx.agent.open() gives one.`);
    }
    const prompt = typeof ask === "string" ? ask : withSkill(host.skill(ask.skill), ask.prompt);
    const output = new Channel<Chunk>();
    const schema = options?.result === undefined ? undefined : jsonSchema(options.result);
    const value = (async () => {
      try {
        stopped.delete(session);
        let failure: string | undefined;
        for (let tries = 0; tries < 2; tries++) {
          const first = !started.has(session);
          started.add(session);
          const sent =
            failure === undefined
              ? prompt
              : `${prompt}\n\n# Correction\n\nThe last attempt failed: ${failure}\nDo the turn again and fix that.`;
          const controller = new AbortController();
          running.set(session, controller);
          let attempt: Attempt;
          try {
            attempt = await runOnce(
              { session, first, options: settings, prompt: sent, schema, signal: controller.signal },
              (chunk) => output.push(chunk),
            );
          } finally {
            running.delete(session);
          }
          if (stopped.has(session)) {
            stopped.delete(session);
            throw new PenguinError("the turn was stopped");
          }
          if (!attempt.ok) {
            failure = attempt.error;
            continue;
          }
          if (options?.result === undefined) return null;
          const checked = options.result.safeParse(attempt.value);
          if (checked.success) return checked.data;
          failure = issuesOf(checked.error);
        }
        throw new PenguinError(`the turn failed twice: ${failure}`);
      } finally {
        output.end();
      }
    })();
    value.catch(() => {});
    return { output, value };
  }) as TurnFn;

  return {
    async open(options?: Options): Promise<string> {
      const id = crypto.randomUUID();
      opened.set(id, options ?? ({} as Options));
      return id;
    },
    turn,
    async stop(session: string): Promise<void> {
      if (!opened.has(session)) {
        throw new PenguinError(`no open session ${session}. ctx.agent.open() gives one.`);
      }
      stopped.add(session);
      running.get(session)?.abort();
    },
  };
}

/** Shows a turn's stream as it arrives: the agent's words as story, its tool calls as actions. */
export function narrate(view: View, output: AsyncIterable<Chunk>): Promise<void> {
  return (async () => {
    for await (const chunk of output) {
      if (chunk.kind === "text") await view.show(chunk.text);
      if (chunk.kind === "tool") await view.act(chunk.call);
    }
  })();
}

/** Runs one turn to its value, narrating the whole stream on the way. */
export async function narrated<T>(view: View, turn: Turn<T>): Promise<T> {
  const shown = narrate(view, turn.output);
  try {
    return await turn.value;
  } finally {
    await shown;
  }
}
