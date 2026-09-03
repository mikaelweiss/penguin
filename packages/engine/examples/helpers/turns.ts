import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  Channel,
  issuesOf,
  messageOf,
  PenguinError,
  RunPaused,
  type Action,
  type AgentChoice,
  type Host,
  type Skill,
  type View,
} from "penguin";

export type Chunk = { kind: "text" | "thinking"; text: string } | { kind: "tool"; call: Action };

/** What a turn runs on: a catalog skill with an optional prompt for the dynamic part, or a prompt alone. */
export type TurnAsk = string | { skill: string; prompt?: string };

export type Turn<T> = { output: AsyncIterable<Chunk>; value: Promise<T> };

/** What one attempt cost, as the CLI reported it. usd is set only when the CLI priced it or a price table did. */
export type Usage = {
  model?: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  usd?: number;
};

export type Attempt =
  | { ok: true; value: unknown; usage?: Usage }
  /** `limited` means the agent hit a usage limit: the run pauses, until `until` when the CLI named it. */
  | { ok: false; error: string; limited?: boolean; until?: string; usage?: Usage };

export type TurnFn = {
  (session: string, ask: TurnAsk): Turn<null>;
  <Shape extends z.ZodObject>(
    session: string,
    ask: TurnAsk,
    options: { result: Shape },
  ): Turn<z.infer<Shape>>;
};

export type AgentApi<Options> = {
  open(options?: Options & AgentChoice): Promise<string>;
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
  /** The CLI's own name for the session, once a turn kept one. */
  thread: string | undefined;
  /** Records the CLI's own name for the session, for every later turn and process. */
  keep(thread: string): void;
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

/** "200000", "200k", or "1M" as a token count. Undefined for "auto" or nothing. */
export function compactTokens(value: string | undefined): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec((value ?? "").trim());
  if (match === null) return undefined;
  const scale = match[2]?.toLowerCase() === "k" ? 1e3 : match[2]?.toLowerCase() === "m" ? 1e6 : 1;
  const tokens = Math.round(Number(match[1]) * scale);
  return tokens > 0 ? tokens : undefined;
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

type Kept<Options> = { options: Options; started: boolean; thread?: string };

/**
 * The sessions a run opened, kept in its folder so the process that resumes the
 * run finds them and carries each conversation on where it stood.
 */
function ledger<Options>(dir: string): {
  table: Record<string, Kept<Options>>;
  save(): void;
} {
  const file = path.join(dir, "sessions.json");
  let table: Record<string, Kept<Options>> = {};
  try {
    table = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Kept<Options>>;
  } catch {
    table = {};
  }
  return { table, save: () => fs.writeFileSync(file, JSON.stringify(table)) };
}

/**
 * The session machinery every agent adapter shares: open handles, run a turn
 * with one corrected retry, pause the run on a usage limit, validate a typed
 * result, note what each attempt cost, and stop mid-flight. The adapter supplies
 * runOnce, the one CLI invocation, and its name for the usage notes.
 */
export function sessions<Options>(
  host: Host,
  runOnce: RunOnce<Options>,
  adapter: string,
): AgentApi<Options> {
  const { table, save } = ledger<Options>(host.run.dir);
  const running = new Map<string, AbortController>();
  const stopped = new Set<string>();

  const turn = ((session: string, ask: TurnAsk, options?: { result?: z.ZodObject }) => {
    const kept = table[session];
    if (kept === undefined) {
      throw new PenguinError(`no open session ${session}. ctx.agent.open() gives one.`);
    }
    const prompt = typeof ask === "string" ? ask : withSkill(host.skill(ask.skill), ask.prompt);
    const skill = typeof ask === "string" ? undefined : ask.skill;
    const output = new Channel<Chunk>();
    const schema = options?.result === undefined ? undefined : jsonSchema(options.result);
    const value = (async () => {
      try {
        stopped.delete(session);
        const halt = (): void => {
          if (!stopped.has(session)) return;
          stopped.delete(session);
          throw new PenguinError("the turn was stopped");
        };
        let failure: string | undefined;
        let tries = 0;
        while (tries < 2) {
          const first = !kept.started;
          kept.started = true;
          save();
          const sent =
            failure === undefined
              ? prompt
              : `${prompt}\n\n# Correction\n\nThe last attempt failed: ${failure}\nDo the turn again and fix that.`;
          const controller = new AbortController();
          running.set(session, controller);
          let attempt: Attempt;
          try {
            attempt = await runOnce(
              {
                session,
                first,
                options: kept.options,
                prompt: sent,
                schema,
                signal: controller.signal,
                thread: kept.thread,
                keep: (thread) => {
                  kept.thread = thread;
                  save();
                },
              },
              (chunk) => output.push(chunk),
            );
          } finally {
            running.delete(session);
          }
          // Every attempt spent tokens, the failed ones too, so each one is written down.
          if (attempt.usage !== undefined) {
            host.note({
              usage: { adapter, session, ...(skill === undefined ? {} : { skill }), ...attempt.usage },
            });
          }
          halt();
          if (!attempt.ok && attempt.limited === true) {
            throw new RunPaused(attempt.error, { by: "limit", until: attempt.until });
          }
          tries++;
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
      table[id] = { options: options ?? ({} as Options), started: false };
      save();
      return id;
    },
    turn,
    async stop(session: string): Promise<void> {
      if (table[session] === undefined) {
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

/** What a turn that will not finish waits at. Nothing but a person ends a run over a failed turn. */
const Again = z.enum(["again", "stop"]);

/**
 * The gate a failed turn waits at. It comes back when the turn is to run again, and throws when
 * the person says the run ends here, so a failing CLI never decides that on its own.
 */
export async function retried(view: View, error: unknown): Promise<void> {
  const answer = await view.ask(
    `The turn did not finish: ${messageOf(error)}\n\nClear what stopped it. again runs it once more, stop ends this run.`,
    Again,
  );
  if (answer === "stop") throw error;
}

/** Runs one turn to its value, narrating the whole stream on the way, and again when it fails. */
export async function narrated<T>(view: View, start: () => Turn<T>): Promise<T> {
  for (;;) {
    const turn = start();
    const shown = narrate(view, turn.output);
    let failure: unknown;
    try {
      return await turn.value;
    } catch (error) {
      failure = error;
    } finally {
      await shown;
    }
    if (failure instanceof RunPaused) throw failure;
    await retried(view, failure);
  }
}
