import crypto from "node:crypto";
import path from "node:path";
import { adapter, type Action, type ActionKind } from "penguin";
import { clip, sessions, targetIn, type Attempt, type Chunk, type Invocation } from "../helpers/turns.ts";

type OpenOptions = {
  cwd?: string;
  model?: string;
  permission?: string;
};

type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};
type StreamLine = {
  type?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  message?: { content?: ContentBlock[] };
};

/** Only this adapter knows claude's tool shapes. */
const target = targetIn([
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "skill",
  "description",
  "prompt",
]);

const KINDS: Record<string, ActionKind> = {
  Bash: "run",
  BashOutput: "run",
  Read: "read",
  NotebookRead: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Grep: "search",
  Glob: "search",
  WebFetch: "fetch",
  WebSearch: "fetch",
  Task: "agent",
  Agent: "agent",
};

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: ContentBlock) => (block?.type === "text" ? (block.text ?? "") : ""))
    .filter((text) => text !== "")
    .join("\n");
}

export default adapter({
  role: "agent",
  name: "claude",
  description:
    "runs prompts on the claude CLI. A session is one conversation: the first turn opens it, later turns resume it.",
  build: (host) => {
    async function runOnce(
      invocation: Invocation<OpenOptions>,
      emit: (chunk: Chunk) => void,
    ): Promise<Attempt> {
      const { session, first, options, prompt, schema, signal } = invocation;
      const argv = ["claude", "-p", "--output-format", "stream-json", "--verbose"];
      if (schema !== undefined) argv.push("--json-schema", JSON.stringify(schema));
      argv.push(first ? "--session-id" : "--resume", session);
      if (options.model !== undefined) argv.push("--model", options.model);
      // A run has no one to ask, so a denied edit costs the turn. `permission` overrides it.
      argv.push("--permission-mode", options.permission ?? "acceptEdits");

      let buffer = "";
      let value: unknown;
      let failed: string | undefined;
      const calls = new Map<string, Action>();
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
              const kind = KINDS[block.name];
              const acted = target(block.input);
              const call: Action = {
                id: block.id ?? crypto.randomUUID(),
                name: block.name,
                status: "running",
                ...(kind === undefined ? {} : { kind }),
                ...(acted === undefined ? {} : { target: acted }),
              };
              calls.set(call.id, call);
              emit({ kind: "tool", call });
            }
          }
        }
        if (event.type === "user") {
          for (const block of event.message?.content ?? []) {
            if (block.type !== "tool_result" || block.tool_use_id === undefined) continue;
            const call = calls.get(block.tool_use_id);
            if (call === undefined) continue;
            const output = clip(resultText(block.content).trim());
            emit({
              kind: "tool",
              call: {
                ...call,
                status: block.is_error === true ? "failed" : "done",
                ...(output === "" ? {} : { output }),
              },
            });
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

    return sessions(host, runOnce);
  },
});
