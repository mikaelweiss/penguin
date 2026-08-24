import path from "node:path";
import { adapter } from "penguin";
import { sessions, targetIn, type Attempt, type Chunk, type Invocation } from "../helpers/turns.ts";

type OpenOptions = {
  cwd?: string;
  model?: string;
  permission?: string;
};

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

    return sessions(host, runOnce);
  },
});
