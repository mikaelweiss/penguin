import crypto from "node:crypto";
import path from "node:path";
import { adapter, type Action, type ActionKind } from "penguin";
import { modelFor, type ModelMap } from "../helpers/models.ts";
import { clip, sessions, targetIn, type Attempt, type Chunk, type Invocation } from "../helpers/turns.ts";

type OpenOptions = {
  cwd?: string;
  model?: string;
  permission?: string;
};

const MODELS = { best: "fable", big: "opus", small: "sonnet" } satisfies ModelMap;

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
  errors?: unknown;
  structured_output?: unknown;
  message?: { content?: ContentBlock[] };
  /** The wrapper fields claude puts beside an assistant message it built from an API error. */
  is_api_error_message?: boolean;
  error?: string;
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

/** What a failed result says: the success field, else the error subtypes' list. */
function reported(event: StreamLine): string {
  if (typeof event.result === "string" && event.result.trim() !== "") return event.result;
  if (Array.isArray(event.errors)) {
    const said = event.errors.map(String).filter((line) => line.trim() !== "");
    if (said.length > 0) return said.join("; ");
  }
  return "claude reported an error";
}

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
      const model = modelFor(options.model, "claude", MODELS, host.config);
      if (model !== undefined) argv.push("--model", model);
      // A run has no one to ask, so any prompt is a denial. `permission` overrides it.
      argv.push("--permission-mode", options.permission ?? "bypassPermissions");

      let buffer = "";
      let value: unknown;
      let failed: string | undefined;
      let limited: string | undefined;
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
          // A limit says itself once. Letting it stream would repeat it on every retry.
          if (event.is_api_error_message === true && event.error === "rate_limit") {
            limited = resultText(event.message?.content).trim();
            return;
          }
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
          if (event.is_error === true) failed = reported(event);
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

      const failure = ((): string | undefined => {
        if (done.code !== 0) {
          const tail = done.stderr.trim().split("\n").at(-1) ?? "";
          return tail === ""
            ? `claude exited with code ${done.code}`
            : `claude exited with code ${done.code}: ${tail}`;
        }
        if (failed !== undefined) return failed;
        if (schema !== undefined && value === undefined) {
          return "claude returned no structured output";
        }
        return undefined;
      })();

      if (failure === undefined) return { ok: true, value: value ?? null };
      // A limit clears on its own, so the turn waits it out rather than spending a retry.
      if (limited !== undefined) {
        const said = limited === "" ? "claude hit its usage limit" : limited;
        return { ok: false, error: said, limited: true };
      }
      return { ok: false, error: failure };
    }

    return sessions(host, runOnce);
  },
});
