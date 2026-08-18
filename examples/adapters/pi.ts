import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adapter } from "penguin";
import type { AgentTurn, AgentTurnResult } from "penguin";

type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
};
type Message = {
  role?: string;
  content?: ContentBlock[];
  stopReason?: string;
  errorMessage?: string;
};
type StreamLine = {
  type?: string;
  message?: Message;
  assistantMessageEvent?: { type?: string; error?: { errorMessage?: string } };
};

const RESULT_TOOL = "penguin_result";

const TARGETS = ["command", "pattern", "path", "url", "query", "description", "prompt"];

/** The one value that says what a tool call acts on. Only this adapter knows pi's tool shapes. */
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

/** pi takes a result schema as a tool, so the schema of one turn rides in as an extension file. */
function extension(schema: Record<string, unknown>): string {
  return `const schema = ${JSON.stringify(schema)};

export default function (pi) {
  pi.registerTool({
    name: ${JSON.stringify(RESULT_TOOL)},
    label: "Penguin Result",
    description: "Return the final result of this step. Call it once, as the last action.",
    promptSnippet: "End the step with a ${RESULT_TOOL} call that carries the result.",
    promptGuidelines: [
      "Call ${RESULT_TOOL} as the final action of the step.",
      "Write no assistant message after ${RESULT_TOOL}.",
    ],
    parameters: schema,
    async execute() {
      return { content: [{ type: "text", text: "result recorded" }], terminate: true };
    },
  });
}
`;
}

export default adapter({
  role: "agent",
  name: "pi",
  description:
    "runs skills on the pi CLI. A handle is one conversation: every turn names the same session id, and pi creates it on the first turn.",
  build: (host) => ({
    async turn(turn: AgentTurn): Promise<AgentTurnResult> {
      const argv = ["pi", "--mode", "json", "--session-id", turn.session];
      const model = turn.options["model"];
      if (typeof model === "string") argv.push("--model", model);
      let temporary: string | undefined;
      if (turn.schema !== undefined) {
        temporary = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-pi-"));
        const file = path.join(temporary, "penguin-result.ts");
        fs.writeFileSync(file, extension(turn.schema));
        argv.push("-e", file);
      }

      let buffer = "";
      let stderr = "";
      let value: unknown;
      let failed = false;
      let why = "";
      /** The first failure wins the turn, and the first reason with words wins the text. */
      const fail = (reason: string | undefined): void => {
        failed = true;
        const text = reason?.trim() ?? "";
        if (why === "" && text !== "") why = text;
      };
      const handle = (line: string): void => {
        if (line.trim() === "") return;
        let event: StreamLine;
        try {
          event = JSON.parse(line) as StreamLine;
        } catch {
          return;
        }
        if (event.type === "message_update") {
          const update = event.assistantMessageEvent;
          if (update?.type === "error") fail(update.error?.errorMessage);
          return;
        }
        if (event.type !== "message_end") return;
        const message = event.message;
        if (message?.role !== "assistant") return;
        for (const block of message.content ?? []) {
          if (block.type === "text" && block.text !== undefined && block.text !== "") {
            host.emit({ type: "agent", session: turn.session, kind: "text", text: block.text });
          }
          if (block.type === "thinking" && block.thinking !== undefined && block.thinking !== "") {
            host.emit({
              type: "agent",
              session: turn.session,
              kind: "thinking",
              text: block.thinking,
            });
          }
          if (block.type === "toolCall" && block.name !== undefined) {
            if (block.name === RESULT_TOOL) {
              value = block.arguments;
              continue;
            }
            host.emit({
              type: "agent",
              session: turn.session,
              kind: "tool",
              text: block.name,
              detail: target(block.arguments),
            });
          }
        }
        if (message.stopReason === "error") fail(message.errorMessage);
      };

      try {
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
            error: tail === "" ? `pi exited with code ${code}` : `pi exited with code ${code}: ${tail}`,
          };
        }
        if (failed) return { ok: false, error: why === "" ? "pi reported an error" : why };
        if (turn.schema !== undefined && value === undefined) {
          return { ok: false, error: "pi returned no structured output" };
        }
        return { ok: true, value: value ?? null };
      } finally {
        if (temporary !== undefined) fs.rmSync(temporary, { recursive: true, force: true });
      }
    },
  }),
});
