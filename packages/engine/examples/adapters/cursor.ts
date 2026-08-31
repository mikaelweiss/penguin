import crypto from "node:crypto";
import path from "node:path";
import { adapter, type Action, type ActionKind } from "penguin";
import { modelFor } from "../helpers/models.ts";
import { flatten, said, sessions, targetIn, type Attempt, type Chunk, type Invocation } from "../helpers/turns.ts";

type OpenOptions = {
  cwd?: string;
  model?: string;
};

type ContentBlock = { type?: string; text?: string };
type ToolCall = { args?: unknown };
type StreamLine = {
  type?: string;
  session_id?: unknown;
  is_error?: boolean;
  result?: unknown;
  call_id?: unknown;
  tool_call?: Record<string, ToolCall>;
  message?: { content?: ContentBlock[] };
};

const ASK = "Reply with one JSON object that matches this JSON Schema:";

/** Only this adapter knows cursor's tool shapes. */
const target = targetIn([
  "command",
  "path",
  "file_path",
  "pattern",
  "query",
  "url",
  "skill",
  "description",
  "prompt",
]);

/** Every top-level {...} run in the text, whatever prose or code fence surrounds it. */
function runs(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\" && quoted) {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (quoted) {
      continue;
    } else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) found.push(text.slice(start, index + 1));
    }
  }
  return found;
}

function lastObject(text: string): unknown {
  for (const run of runs(text).reverse()) {
    let value: unknown;
    try {
      value = JSON.parse(run);
    } catch {
      continue;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return undefined;
}

function toolName(call: Record<string, ToolCall>): string | undefined {
  const [key] = Object.keys(call);
  if (key === undefined) return undefined;
  return key.endsWith("ToolCall") ? key.slice(0, -"ToolCall".length) : key;
}

const KINDS: Record<string, ActionKind> = {
  shell: "run",
  bash: "run",
  read: "read",
  ls: "read",
  edit: "edit",
  write: "edit",
  delete: "edit",
  grep: "search",
  glob: "search",
  search: "search",
  fetch: "fetch",
  task: "agent",
};

export default adapter({
  role: "agent",
  name: "cursor",
  description:
    "runs prompts on the cursor-agent CLI. A session is one cursor chat: the first turn opens the chat, later turns resume it. The CLI takes no schema, so a typed result is asked for in the prompt and read back out of the reply.",
  build: (host) => {
    const chats = new Map<string, string>();

    async function runOnce(
      invocation: Invocation<OpenOptions>,
      emit: (chunk: Chunk) => void,
    ): Promise<Attempt> {
      const { session, options, schema, signal } = invocation;
      const argv = ["cursor-agent", "-p", "--force", "--output-format", "stream-json", "--trust"];
      const chat = chats.get(session);
      if (chat !== undefined) argv.push("--resume", chat);
      argv.push("--model", modelFor(options.model, "cursor", {}, host.config) ?? "grok-4.6");
      const prompt =
        schema === undefined
          ? invocation.prompt
          : `${invocation.prompt}\n\n${ASK}\n${JSON.stringify(schema)}\n`;

      const called = new Map<string, Action>();
      let buffer = "";
      let answer = "";
      let failed: string | undefined;
      const handle = (line: string): void => {
        if (line.trim() === "") return;
        let event: StreamLine;
        try {
          event = JSON.parse(line) as StreamLine;
        } catch {
          return;
        }
        if (typeof event.session_id === "string" && event.session_id !== "") {
          chats.set(session, event.session_id);
        }
        if (event.type === "assistant") {
          for (const block of event.message?.content ?? []) {
            if (block.type === "text" && block.text !== undefined && block.text !== "") {
              emit({ kind: "text", text: block.text });
            }
          }
        }
        if (event.type === "tool_call" && event.tool_call !== undefined) {
          const id = said(event.call_id) ? event.call_id : crypto.randomUUID();
          const name = toolName(event.tool_call);
          const started = called.get(id);
          // The stream repeats a call_id when the call finishes, and says no more than that.
          if (started !== undefined) {
            emit({ kind: "tool", call: { ...started, status: "done" } });
          } else if (name !== undefined) {
            const kind = KINDS[name];
            const acted = target(Object.values(event.tool_call)[0]?.args);
            const call: Action = {
              id,
              name,
              status: "running",
              ...(kind === undefined ? {} : { kind }),
              ...(acted === undefined ? {} : { target: acted }),
            };
            called.set(id, call);
            emit({ kind: "tool", call });
          }
        }
        if (event.type === "result") {
          if (event.is_error === true) {
            failed = said(event.result) ? event.result : "cursor-agent reported an error";
          }
          if (typeof event.result === "string") answer = event.result;
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
              ? `cursor-agent exited with code ${done.code}`
              : `cursor-agent exited with code ${done.code}: ${tail}`,
        };
      }
      if (failed !== undefined) return { ok: false, error: failed };
      if (schema === undefined) return { ok: true, value: null };
      const value = lastObject(answer);
      if (value === undefined) {
        const text = flatten(answer);
        return {
          ok: false,
          error:
            text === ""
              ? "cursor-agent returned no text"
              : `cursor-agent returned no JSON object: ${text}`,
        };
      }
      return { ok: true, value };
    }

    return sessions(host, runOnce, "cursor");
  },
});
