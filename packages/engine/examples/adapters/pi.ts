import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adapter, type ActionKind } from "penguin";
import { modelFor } from "../helpers/models.ts";
import {
  sessions,
  targetIn,
  type Attempt,
  type Chunk,
  type Invocation,
  type Usage,
} from "../helpers/turns.ts";

type OpenOptions = {
  cwd?: string;
  model?: string;
};

type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
};
type Spent = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};
type Message = {
  role?: string;
  model?: string;
  content?: ContentBlock[];
  stopReason?: string;
  errorMessage?: string;
  /** What this one model call cost. A turn is the sum over its assistant messages. */
  usage?: Spent;
};
type StreamLine = {
  type?: string;
  message?: Message;
  assistantMessageEvent?: { type?: string; error?: { errorMessage?: string } };
};

const RESULT_TOOL = "penguin_result";

/** Only this adapter knows pi's tool shapes. */
const target = targetIn(["command", "pattern", "path", "url", "query", "description", "prompt"]);

const KINDS: Record<string, ActionKind> = {
  bash: "run",
  read: "read",
  list: "read",
  edit: "edit",
  write: "edit",
  grep: "search",
  glob: "search",
  fetch: "fetch",
};

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The turn's usage so far with one more assistant message added in. */
function added(total: Usage | undefined, message: Message): Usage {
  const spent = message.usage ?? {};
  const base: Usage = total ?? {
    ...(typeof message.model === "string" && message.model !== "" ? { model: message.model } : {}),
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    usd: 0,
  };
  return {
    ...base,
    input: base.input + count(spent.input),
    cacheRead: base.cacheRead + count(spent.cacheRead),
    cacheWrite: base.cacheWrite + count(spent.cacheWrite),
    output: base.output + count(spent.output),
    usd: Math.round(((base.usd ?? 0) + count(spent.cost?.total)) * 1e6) / 1e6,
  };
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
  async check(host) {
    const there = await host.shell("command -v pi");
    return there.code === 0 ? [] : ["pi is not installed or not on PATH."];
  },
  description:
    "runs prompts on the pi CLI. A session is one conversation: every turn names the same session id, and pi creates it on the first turn.",
  build: (host) => {
    async function runOnce(
      invocation: Invocation<OpenOptions>,
      emit: (chunk: Chunk) => void,
    ): Promise<Attempt> {
      const { session, options, prompt, schema, signal } = invocation;
      const argv = ["pi", "--mode", "json", "--session-id", session];
      const model = modelFor(options.model, "pi", {}, host.config);
      if (model !== undefined) argv.push("--model", model);
      let temporary: string | undefined;
      if (schema !== undefined) {
        temporary = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-pi-"));
        const file = path.join(temporary, "penguin-result.ts");
        fs.writeFileSync(file, extension(schema));
        argv.push("-e", file);
      }

      let buffer = "";
      let value: unknown;
      let usage: Usage | undefined;
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
        if (message.usage !== undefined) usage = added(usage, message);
        for (const block of message.content ?? []) {
          if (block.type === "text" && block.text !== undefined && block.text !== "") {
            emit({ kind: "text", text: block.text });
          }
          if (block.type === "thinking" && block.thinking !== undefined && block.thinking !== "") {
            emit({ kind: "thinking", text: block.thinking });
          }
          if (block.type === "toolCall" && block.name !== undefined) {
            if (block.name === RESULT_TOOL) {
              value = block.arguments;
              continue;
            }
            const kind = KINDS[block.name];
            const acted = target(block.arguments);
            emit({
              kind: "tool",
              call: {
                id: crypto.randomUUID(),
                name: block.name,
                status: "running",
                ...(kind === undefined ? {} : { kind }),
                ...(acted === undefined ? {} : { target: acted }),
              },
            });
          }
        }
        if (message.stopReason === "error") fail(message.errorMessage);
      };

      try {
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

        const spent = usage === undefined ? {} : { usage };
        if (done.code !== 0) {
          const tail = done.stderr.trim().split("\n").at(-1) ?? "";
          return {
            ok: false,
            error:
              tail === ""
                ? `pi exited with code ${done.code}`
                : `pi exited with code ${done.code}: ${tail}`,
            ...spent,
          };
        }
        if (failed) return { ok: false, error: why === "" ? "pi reported an error" : why, ...spent };
        if (schema !== undefined && value === undefined) {
          return { ok: false, error: "pi returned no structured output", ...spent };
        }
        return { ok: true, value: value ?? null, ...spent };
      } finally {
        if (temporary !== undefined) fs.rmSync(temporary, { recursive: true, force: true });
      }
    }

    return sessions(host, runOnce, "pi");
  },
});
