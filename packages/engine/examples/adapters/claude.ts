import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { adapter, Channel, issuesOf, PenguinError } from "penguin";

type OpenOptions = {
  cwd?: string;
  model?: string;
  permission?: string;
};

type Chunk = { kind: "text" | "thinking" | "tool"; text: string; detail?: string };

type Turn<T> = { output: AsyncIterable<Chunk>; value: Promise<T> };

type TurnFn = {
  (session: string, prompt: string): Turn<null>;
  <Shape extends z.ZodObject>(
    session: string,
    prompt: string,
    options: { result: Shape },
  ): Turn<z.infer<Shape>>;
};

type Attempt = { ok: true; value: unknown } | { ok: false; error: string };

type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
};
type StreamLine = {
  type?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  message?: { content?: ContentBlock[] };
};

const TARGETS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "skill",
  "description",
  "prompt",
];

/** The one value that says what a tool call acts on. Only this adapter knows claude's tool shapes. */
function target(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const values = input as Record<string, unknown>;
  const named = TARGETS.map((field) => values[field]).find(said);
  if (named !== undefined) return flatten(named as string);
  const first = Object.values(values).find(said);
  return first === undefined ? undefined : flatten(first as string);
}

function said(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function jsonSchema(shape: z.ZodObject): Record<string, unknown> {
  const schema = z.toJSONSchema(shape) as Record<string, unknown>;
  delete schema["$schema"];
  return schema;
}

export default adapter({
  role: "agent",
  name: "claude",
  description:
    "runs prompts on the claude CLI. A session is one conversation: the first turn opens it, later turns resume it.",
  build: (host) => {
    const sessions = new Map<string, OpenOptions>();
    const started = new Set<string>();
    const running = new Map<string, AbortController>();
    const stopped = new Set<string>();

    async function runOnce(
      session: string,
      first: boolean,
      options: OpenOptions,
      prompt: string,
      schema: Record<string, unknown> | undefined,
      signal: AbortSignal,
      emit: (chunk: Chunk) => void,
    ): Promise<Attempt> {
      const argv = ["claude", "-p", "--output-format", "stream-json", "--verbose"];
      if (schema !== undefined) argv.push("--json-schema", JSON.stringify(schema));
      argv.push(first ? "--session-id" : "--resume", session);
      if (options.model !== undefined) argv.push("--model", options.model);
      // A run has no one to ask, so a denied edit costs the turn. `permission` overrides it.
      argv.push("--permission-mode", options.permission ?? "acceptEdits");

      let buffer = "";
      let value: unknown;
      let failed: string | undefined;
      const handle = (line: string): void => {
        if (line.trim() === "") return;
        let event: StreamLine;
        try {
          event = JSON.parse(line) as StreamLine;
        } catch {
          return;
        }
        if (event.type === "assistant") {
          for (const block of event.message?.content ?? []) {
            if (block.type === "text" && block.text !== undefined && block.text !== "") {
              emit({ kind: "text", text: block.text });
            }
            if (block.type === "thinking" && block.thinking !== undefined && block.thinking !== "") {
              emit({ kind: "thinking", text: block.thinking });
            }
            if (block.type === "tool_use" && block.name !== undefined) {
              emit({ kind: "tool", text: block.name, detail: target(block.input) });
            }
          }
        }
        if (event.type === "result") {
          if (event.is_error === true) {
            failed = typeof event.result === "string" ? event.result : "claude reported an error";
          }
          value = event.structured_output;
        }
      };

      const done = await host.exec(argv, {
        cwd: path.resolve(host.cwd, options.cwd ?? "."),
        stdin: prompt,
        signal,
        onOutput: (chunk, stream) => {
          if (stream !== "stdout") return;
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) handle(line);
        },
      });
      if (buffer.trim() !== "") handle(buffer);

      if (done.code !== 0) {
        const tail = done.stderr.trim().split("\n").at(-1) ?? "";
        return {
          ok: false,
          error:
            tail === ""
              ? `claude exited with code ${done.code}`
              : `claude exited with code ${done.code}: ${tail}`,
        };
      }
      if (failed !== undefined) return { ok: false, error: failed };
      if (schema !== undefined && value === undefined) {
        return { ok: false, error: "claude returned no structured output" };
      }
      return { ok: true, value: value ?? null };
    }

    const turn = ((session: string, prompt: string, options?: { result?: z.ZodObject }) => {
      const opened = sessions.get(session);
      if (opened === undefined) {
        throw new PenguinError(`no open session ${session}. ctx.agent.open() gives one.`);
      }
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
              attempt = await runOnce(session, first, opened, sent, schema, controller.signal, (chunk) =>
                output.push(chunk),
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
      async open(options?: OpenOptions): Promise<string> {
        const id = crypto.randomUUID();
        sessions.set(id, options ?? {});
        return id;
      },
      turn,
      /** Ends the running turn. The session stays open for the next one. */
      async stop(session: string): Promise<void> {
        if (!sessions.has(session)) {
          throw new PenguinError(`no open session ${session}. ctx.agent.open() gives one.`);
        }
        stopped.add(session);
        running.get(session)?.abort();
      },
    };
  },
});
