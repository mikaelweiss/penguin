import { adapter } from "penguin";
import type { AgentTurn, AgentTurnResult } from "penguin";

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

const TARGETS = [
  "command",
  "path",
  "file_path",
  "pattern",
  "query",
  "url",
  "skill",
  "description",
  "prompt",
];

const ASK = "Reply with one JSON object that matches this JSON Schema:";

/** The one value that says what a tool call acts on. Only this adapter knows cursor's tool shapes. */
function target(args: unknown): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const values = args as Record<string, unknown>;
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

export default adapter({
  role: "agent",
  name: "cursor",
  description:
    "runs skills on the cursor-agent CLI. A handle is one cursor chat: the first turn opens the chat, later turns resume it.",
  build: (host) => {
    const chats = new Map<string, string>();
    return {
      async turn(turn: AgentTurn): Promise<AgentTurnResult> {
        const argv = ["cursor-agent", "-p", "--force", "--output-format", "stream-json", "--trust"];
        const chat = chats.get(turn.session);
        if (chat !== undefined) argv.push("--resume", chat);
        const model = turn.options["model"];
        argv.push("--model", typeof model === "string" ? model : "grok-4.6");
        const prompt =
          turn.schema === undefined
            ? turn.prompt
            : `${turn.prompt}\n\n${ASK}\n${JSON.stringify(turn.schema)}\n`;

        const called = new Set<string>();
        let buffer = "";
        let stderr = "";
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
            chats.set(turn.session, event.session_id);
          }
          if (event.type === "assistant") {
            for (const block of event.message?.content ?? []) {
              if (block.type === "text" && block.text !== undefined && block.text !== "") {
                host.emit({ type: "agent", session: turn.session, kind: "text", text: block.text });
              }
            }
          }
          if (event.type === "tool_call" && event.tool_call !== undefined) {
            const id = said(event.call_id) ? String(event.call_id) : undefined;
            const name = toolName(event.tool_call);
            if (name !== undefined && (id === undefined || !called.has(id))) {
              if (id !== undefined) called.add(id);
              host.emit({
                type: "agent",
                session: turn.session,
                kind: "tool",
                text: name,
                detail: target(Object.values(event.tool_call)[0]?.args),
              });
            }
          }
          if (event.type === "result") {
            if (event.is_error === true) {
              failed = said(event.result)
                ? (event.result as string)
                : "cursor-agent reported an error";
            }
            if (typeof event.result === "string") answer = event.result;
          }
        };

        const code = await host.exec(argv, {
          cwd: turn.cwd,
          stdin: prompt,
          onOutput: (chunk, stream) => {
            if (stream === "stderr") {
              stderr += chunk;
              return;
            }
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) handle(line);
          },
        });
        if (buffer.trim() !== "") handle(buffer);

        if (code !== 0) {
          const tail = stderr.trim().split("\n").at(-1) ?? "";
          return {
            ok: false,
            error:
              tail === ""
                ? `cursor-agent exited with code ${code}`
                : `cursor-agent exited with code ${code}: ${tail}`,
          };
        }
        if (failed !== undefined) return { ok: false, error: failed };
        if (turn.schema === undefined) return { ok: true, value: null };
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
      },
    };
  },
});
