import crypto from "node:crypto";
import path from "node:path";
import { adapter, type Action, type ActionKind } from "penguin";
import { clip, said, sessions, targetIn, type Attempt, type Chunk, type Invocation } from "../helpers/turns.ts";

type OpenOptions = {
  cwd?: string;
  model?: string;
  agent?: string;
};

type ToolState = {
  status?: string;
  input?: unknown;
  output?: string;
  error?: unknown;
};
type Part = {
  id?: string;
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

/** Only this adapter knows opencode's tool shapes. */
const target = targetIn([
  "command",
  "filePath",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
]);

function reason(error: unknown): string {
  if (said(error)) return error;
  if (error === null || typeof error !== "object") return "opencode reported an error";
  const values = error as { message?: unknown; data?: { message?: unknown } };
  const message = values.message ?? values.data?.message;
  return said(message) ? message : JSON.stringify(error);
}

const KINDS: Record<string, ActionKind> = {
  bash: "run",
  shell: "run",
  read: "read",
  list: "read",
  edit: "edit",
  write: "edit",
  patch: "edit",
  apply_patch: "edit",
  grep: "search",
  glob: "search",
  webfetch: "fetch",
  websearch: "fetch",
  task: "agent",
};

function act(part: Part, id: string): Action {
  const state = part.state;
  const status =
    state?.status === "error" ? "failed" : state?.status === "completed" ? "done" : "running";
  const kind = KINDS[part.tool ?? ""];
  const acted = target(state?.input);
  const returned = state?.output;
  const raw = status === "failed" ? reason(state?.error) : said(returned) ? returned : "";
  const output = status === "running" ? "" : clip(raw.trim());
  return {
    id,
    name: part.tool ?? "tool",
    status,
    ...(kind === undefined ? {} : { kind }),
    ...(acted === undefined ? {} : { target: acted }),
    ...(output === "" ? {} : { output }),
  };
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

function asked(prompt: string, schema: Record<string, unknown> | undefined): string {
  if (schema === undefined) return prompt;
  return `${prompt}\n\nReply with one JSON object and no other text. It must match this JSON Schema:\n${JSON.stringify(schema)}`;
}

export default adapter({
  role: "agent",
  name: "opencode",
  description:
    "runs prompts on the opencode CLI. A session is one conversation: the first turn opens it, later turns resume it over --session. The CLI takes no schema, so a typed result is asked for in the prompt and read back out of the reply.",
  build: (host) => {
    /**
     * opencode names its own sessions, so penguin's handle cannot be the session id.
     * The first turn of a handle reads the id off the event stream and keeps it here.
     */
    const opened = new Map<string, string>();

    async function runOnce(
      invocation: Invocation<OpenOptions>,
      emit: (chunk: Chunk) => void,
    ): Promise<Attempt> {
      const { session, options, prompt, schema, signal } = invocation;
      const argv = ["opencode", "run", "--auto", "--format", "json"];
      const id = opened.get(session);
      if (id !== undefined) argv.push("--session", id);
      if (options.model !== undefined) argv.push("--model", options.model);
      if (options.agent !== undefined) argv.push("--agent", options.agent);

      let buffer = "";
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
        if (said(opening)) opened.set(session, opening);
        const part = event.part;
        const body = part?.text;
        if (event.type === "text" && said(body)) {
          text += body;
          emit({ kind: "text", text: body });
        }
        if (event.type === "reasoning" && said(body)) {
          emit({ kind: "thinking", text: body });
        }
        if (event.type === "tool_use" && part?.tool !== undefined) {
          emit({ kind: "tool", call: act(part, part.id ?? crypto.randomUUID()) });
        }
        if (event.type === "error") failed = reason(event.error);
      };

      const done = await host.exec(argv, {
        cwd: path.resolve(host.cwd, options.cwd ?? "."),
        stdin: asked(prompt, schema),
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

      /** The reason rides an error event on stdout. opencode writes stderr under --print-logs only. */
      if (failed !== undefined) return { ok: false, error: failed };
      if (done.code !== 0) {
        const tail = done.stderr.trim().split("\n").at(-1) ?? "";
        return {
          ok: false,
          error:
            tail === ""
              ? `opencode exited with code ${done.code}`
              : `opencode exited with code ${done.code}: ${tail}`,
        };
      }
      if (schema === undefined) return { ok: true, value: null };
      const value = structured(text);
      if (value === undefined) return { ok: false, error: "opencode returned no JSON result" };
      return { ok: true, value };
    }

    return sessions(host, runOnce);
  },
});
