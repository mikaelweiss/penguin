import crypto from "node:crypto";
import path from "node:path";
import { adapter, type Action, type ActionKind } from "penguin";
import { modelFor, type ModelMap } from "../helpers/models.ts";
import { clip, flatten, said, sessions, targetIn, type Attempt, type Chunk, type Invocation } from "../helpers/turns.ts";

type OpenOptions = {
  cwd?: string;
  model?: string;
  mode?: string;
};

const MODELS = {
  small: "claude-haiku-4.5",
  normal: "claude-sonnet-4.6",
  big: "gpt-5.3-codex",
} satisfies ModelMap;

type StreamLine = {
  type?: string;
  data?: Record<string, unknown>;
};

const ASK = "Reply with one JSON object that matches this JSON Schema:";

/** Only this adapter knows copilot's tool shapes. */
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

const KINDS: Record<string, ActionKind> = {
  bash: "run",
  shell: "run",
  execute: "run",
  view: "read",
  read_file: "read",
  show_file: "read",
  ls: "read",
  create: "edit",
  write: "edit",
  write_file: "edit",
  str_replace: "edit",
  edit: "edit",
  replace: "edit",
  edit_file: "edit",
  apply_patch: "edit",
  rg: "search",
  grep: "search",
  glob: "search",
  web_search: "fetch",
  web_fetch: "fetch",
};

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

function payload(event: StreamLine): Record<string, unknown> {
  const data = event.data;
  if (data !== null && typeof data === "object" && !Array.isArray(data)) return data;
  return {};
}

function named(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = keys.map((key) => data[key]).find(said);
  return value;
}

function resultText(result: unknown): string {
  if (said(result)) return result;
  if (result === null || typeof result !== "object") return "";
  const body = result as { content?: unknown; detailedContent?: unknown };
  if (said(body.detailedContent)) return body.detailedContent;
  if (said(body.content)) return body.content;
  return "";
}

export default adapter({
  role: "agent",
  name: "copilot",
  async check(host) {
    const there = await host.shell("command -v copilot");
    return there.code === 0 ? [] : ["copilot is not installed or not on PATH."];
  },
  description:
    "runs prompts on the copilot CLI. A session is one conversation: every turn names the same session id, and copilot creates it on the first turn. The CLI takes no schema, so a typed result is asked for in the prompt and read back out of the reply. Its event stream reports no token usage, so a copilot turn writes no usage note.",
  build: (host) => {
    async function runOnce(
      invocation: Invocation<OpenOptions>,
      emit: (chunk: Chunk) => void,
    ): Promise<Attempt> {
      const { session, options, schema, signal } = invocation;
      const prompt =
        schema === undefined
          ? invocation.prompt
          : `${invocation.prompt}\n\n${ASK}\n${JSON.stringify(schema)}\n`;
      // -p is how copilot takes a prompt and exits. A run has no one to ask, so
      // all tools, paths, and URLs are allowed, and the agent may not ask.
      const argv = [
        "copilot",
        "-p",
        prompt,
        "--output-format",
        "json",
        "--allow-all",
        "--no-ask-user",
        "--mode",
        options.mode ?? "autopilot",
        "--session-id",
        session,
      ];
      const model = modelFor(options.model, "copilot", MODELS, host.config);
      if (model !== undefined) argv.push("--model", model);

      const called = new Map<string, Action>();
      let buffer = "";
      let answer = "";
      let failed: string | undefined;
      let limited: string | undefined;
      const handle = (line: string): void => {
        if (line.trim() === "") return;
        let event: StreamLine;
        try {
          event = JSON.parse(line) as StreamLine;
        } catch {
          return;
        }
        const data = payload(event);
        if (event.type === "assistant.message") {
          const text = said(data["content"]) ? data["content"] : "";
          if (text === "") return;
          if (data["phase"] === "thinking") {
            emit({ kind: "thinking", text });
            return;
          }
          answer = text;
          emit({ kind: "text", text });
        }
        if (event.type === "assistant.reasoning" && said(data["content"])) {
          emit({ kind: "thinking", text: data["content"] });
        }
        if (event.type === "tool.execution_start") {
          const name = named(data, "toolName", "tool_name");
          if (name === undefined) return;
          const server = named(data, "mcpServerName", "mcp_server_name");
          const mcp = named(data, "mcpToolName", "mcp_tool_name");
          const shown = server === undefined ? name : `${server}.${mcp ?? name}`;
          const id = named(data, "toolCallId", "tool_call_id") ?? crypto.randomUUID();
          const kind = KINDS[name];
          const acted = target(data["arguments"]);
          const call: Action = {
            id,
            name: shown,
            status: "running",
            ...(kind === undefined ? {} : { kind }),
            ...(acted === undefined ? {} : { target: acted }),
          };
          called.set(id, call);
          emit({ kind: "tool", call });
        }
        if (event.type === "tool.execution_complete") {
          const id = named(data, "toolCallId", "tool_call_id");
          if (id === undefined) return;
          const started = called.get(id);
          if (started === undefined) return;
          const output = clip(resultText(data["result"]).trim());
          const error = data["error"];
          const why =
            error !== null && typeof error === "object"
              ? (error as { message?: unknown }).message
              : undefined;
          const broke = data["success"] === false;
          emit({
            kind: "tool",
            call: {
              ...started,
              status: broke ? "failed" : "done",
              ...(output === "" ? {} : { output }),
              ...(broke && said(why) && output === "" ? { output: clip(why.trim()) } : {}),
            },
          });
        }
        if (event.type === "session.error") {
          const message = said(data["message"]) ? data["message"] : "copilot reported an error";
          failed = message;
          if (data["errorType"] === "rate_limit" || data["error_type"] === "rate_limit") {
            limited = message;
          }
        }
      };

      const done = await host.exec(argv, {
        cwd: path.resolve(host.cwd, options.cwd ?? "."),
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

      const failure = ((): string | undefined => {
        if (done.code !== 0) {
          const tail = done.stderr.trim().split("\n").at(-1) ?? "";
          return tail === ""
            ? `copilot exited with code ${done.code}`
            : `copilot exited with code ${done.code}: ${tail}`;
        }
        if (failed !== undefined) return failed;
        if (schema !== undefined && lastObject(answer) === undefined) {
          const text = flatten(answer);
          return text === ""
            ? "copilot returned no text"
            : `copilot returned no JSON object: ${text}`;
        }
        return undefined;
      })();

      if (failure === undefined) {
        return { ok: true, value: schema === undefined ? null : lastObject(answer) };
      }
      if (limited !== undefined) {
        return { ok: false, error: limited, limited: true };
      }
      return { ok: false, error: failure };
    }

    return sessions(host, runOnce, "copilot");
  },
});
