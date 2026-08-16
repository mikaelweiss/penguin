import { adapter } from "wa";
import type { AgentTurn, AgentTurnResult } from "wa";

type ContentBlock = { type?: string; text?: string; name?: string };
type StreamLine = {
  type?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  message?: { content?: ContentBlock[] };
};

export default adapter({
  role: "agent",
  name: "claude",
  description:
    "runs skills on the claude CLI. A handle is one conversation: the first turn opens the session, later turns resume it.",
  build: (host) => ({
    async turn(turn: AgentTurn): Promise<AgentTurnResult> {
      const argv = ["claude", "-p", "--output-format", "stream-json", "--verbose"];
      if (turn.schema !== undefined) argv.push("--json-schema", JSON.stringify(turn.schema));
      argv.push(turn.first ? "--session-id" : "--resume", turn.session);
      const model = turn.options["model"];
      if (typeof model === "string") argv.push("--model", model);

      let buffer = "";
      let stderr = "";
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
              host.emit({ type: "agent", session: turn.session, kind: "text", text: block.text });
            }
            if (block.type === "tool_use" && block.name !== undefined) {
              host.emit({ type: "agent", session: turn.session, kind: "tool", text: block.name });
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

      const code = await host.exec(argv, {
        cwd: turn.cwd,
        stdin: turn.prompt,
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
          error: tail === "" ? `claude exited with code ${code}` : `claude exited with code ${code}: ${tail}`,
        };
      }
      if (failed !== undefined) return { ok: false, error: failed };
      if (turn.schema !== undefined && value === undefined) {
        return { ok: false, error: "claude returned no structured output" };
      }
      return { ok: true, value: value ?? null };
    },
  }),
});
