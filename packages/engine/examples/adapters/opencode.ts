import { adapter } from "penguin";
import type { AgentTurn, AgentTurnResult } from "penguin";

type ToolState = {
  status?: string;
  input?: unknown;
};
type Part = {
  type?: string;
  text?: string;
  tool?: string;
  state?: ToolState;
};
type StreamLine = {
  type?: string;
  sessionID?: string;
  part?: Part;
  error?: unknown;
};

const TARGETS = [
  "command",
  "filePath",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
];

/** The one value that says what a tool call acts on. Only this adapter knows opencode's tool shapes. */
function target(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const values = input as Record<string, unknown>;
  const named = TARGETS.map((field) => values[field]).find(said);
  if (named !== undefined) return flatten(named);
  const first = Object.values(values).find(said);
  return first === undefined ? undefined : flatten(first);
}

function said(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function reason(error: unknown): string {
  if (said(error)) return error;
  if (error === null || typeof error !== "object") return "opencode reported an error";
  const values = error as { message?: unknown; data?: { message?: unknown } };
  const message = values.message ?? values.data?.message;
  return said(message) ? message : JSON.stringify(error);
}

/** Every JSON the reply could hold, last block first: a model often shows an example before the answer. */
function candidates(text: string): string[] {
  const found = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)]
    .map((match) => match[1] ?? "")
    .reverse();
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open !== -1 && close > open) found.push(text.slice(open, close + 1));
  return found;
}

function structured(text: string): unknown {
  for (const candidate of candidates(text)) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}

function asked(turn: AgentTurn): string {
  if (turn.schema === undefined) return turn.prompt;
  const schema = JSON.stringify(turn.schema);
  return `${turn.prompt}\n\nReply with one JSON object and no other text. It must match this JSON Schema:\n${schema}`;
}

export default adapter({
  role: "agent",
  name: "opencode",
  description:
    "runs skills on the opencode CLI. A handle is one conversation: the first turn opens the session, later turns resume it over --session. The CLI takes no schema, so a typed result is asked for in the prompt and read back out of the reply.",
  build: (host) => {
    /**
     * opencode names its own sessions, so penguin's handle cannot be the session id.
     * The first turn of a handle reads the id off the event stream and keeps it here.
     */
    const opened = new Map<string, string>();

    return {
      async turn(turn: AgentTurn): Promise<AgentTurnResult> {
        const argv = ["opencode", "run", "--format", "json"];
        /**
         * turn.first cannot drive this: a retry of a failed first turn arrives with
         * first false and nothing opened. The recorded id is the only truth.
         */
        const id = opened.get(turn.session);
        if (id !== undefined) argv.push("--session", id);
        const model = turn.options["model"];
        if (typeof model === "string") argv.push("--model", model);
        const named = turn.options["agent"];
        if (typeof named === "string") argv.push("--agent", named);

        let buffer = "";
        let stderr = "";
        let text = "";
        let failed: string | undefined;
        const handle = (line: string): void => {
          if (line.trim() === "") return;
          let event: StreamLine;
          try {
            event = JSON.parse(line) as StreamLine;
          } catch {
            return;
          }
          const opening = event.sessionID;
          if (said(opening)) opened.set(turn.session, opening);
          const part = event.part;
          const body = part?.text;
          if (event.type === "text" && said(body)) {
            text += body;
            host.emit({ type: "agent", session: turn.session, kind: "text", text: body });
          }
          if (event.type === "reasoning" && said(body)) {
            host.emit({ type: "agent", session: turn.session, kind: "thinking", text: body });
          }
          if (event.type === "tool_use" && part?.tool !== undefined) {
            host.emit({
              type: "agent",
              session: turn.session,
              kind: "tool",
              text: part.tool,
              detail: target(part.state?.input),
            });
          }
          if (event.type === "error") failed = reason(event.error);
        };

        const code = await host.exec(argv, {
          cwd: turn.cwd,
          stdin: asked(turn),
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

        /** The reason rides an error event on stdout. opencode writes stderr under --print-logs only. */
        if (failed !== undefined) return { ok: false, error: failed };
        if (code !== 0) {
          const tail = stderr.trim().split("\n").at(-1) ?? "";
          return {
            ok: false,
            error:
              tail === ""
                ? `opencode exited with code ${code}`
                : `opencode exited with code ${code}: ${tail}`,
          };
        }
        if (turn.schema === undefined) return { ok: true, value: null };
        const value = structured(text);
        if (value === undefined) return { ok: false, error: "opencode returned no JSON result" };
        return { ok: true, value };
      },
    };
  },
});
