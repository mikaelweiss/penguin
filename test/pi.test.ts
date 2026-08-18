import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadAdapter } from "../src/adapters.ts";
import type { AgentAdapter, AgentTurn, AgentTurnResult, Host, ViewEvent } from "../src/types.ts";

const file = fileURLToPath(new URL("../examples/adapters/pi.ts", import.meta.url));

type Run = {
  argv: string[];
  cwd: string | undefined;
  stdin: string | undefined;
  extension: string | undefined;
};

type Box = {
  turn(turn?: Partial<AgentTurn>): Promise<AgentTurnResult>;
  events: ViewEvent[];
  runs: Run[];
};

async function pi(lines: unknown[], outcome: { code?: number; stderr?: string } = {}): Promise<Box> {
  const events: ViewEvent[] = [];
  const runs: Run[] = [];
  const host: Host = {
    cwd: "/repo",
    shell: async () => ({ code: 0, stdout: "", stderr: "" }),
    async exec(argv, options) {
      const at = argv.indexOf("-e");
      const written = at === -1 ? undefined : String(argv[at + 1]);
      runs.push({
        argv,
        cwd: options?.cwd,
        stdin: options?.stdin,
        extension: written === undefined ? undefined : fs.readFileSync(written, "utf8"),
      });
      const text = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
      const split = Math.floor(text.length / 3);
      options?.onOutput?.(text.slice(0, split), "stdout");
      options?.onOutput?.(text.slice(split), "stdout");
      if (outcome.stderr !== undefined) options?.onOutput?.(outcome.stderr, "stderr");
      return outcome.code ?? 0;
    },
    wait: (_label, body) => body(),
    emit: (event) => {
      events.push(event);
    },
    credential: async () => ({}) as never,
  };
  const api = (await loadAdapter(file)).build(host) as AgentAdapter;
  return {
    events,
    runs,
    turn: (turn = {}) =>
      api.turn({
        session: "s-1",
        first: true,
        cwd: "/repo",
        prompt: "do the thing",
        options: {},
        ...turn,
      }),
  };
}

test("the pi adapter turns each content block into one agent event", async () => {
  const box = await pi([
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "I will" } },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "the footer needs a fixed position" },
          { type: "text", text: "I will pin the footer." },
          {
            type: "toolCall",
            name: "bash",
            arguments: { command: "bun test\n  test/footer.test.ts" },
          },
          { type: "toolCall", name: "read", arguments: { path: "src/footer.ts" } },
        ],
        stopReason: "stop",
      },
    },
  ]);

  const result = await box.turn({ cwd: "/repo/work" });

  assert.deepEqual(result, { ok: true, value: null });
  assert.deepEqual(box.events, [
    { type: "agent", session: "s-1", kind: "thinking", text: "the footer needs a fixed position" },
    { type: "agent", session: "s-1", kind: "text", text: "I will pin the footer." },
    {
      type: "agent",
      session: "s-1",
      kind: "tool",
      text: "bash",
      detail: "bun test test/footer.test.ts",
    },
    { type: "agent", session: "s-1", kind: "tool", text: "read", detail: "src/footer.ts" },
  ]);
  assert.deepEqual(box.runs[0]?.argv, ["pi", "--mode", "json", "--session-id", "s-1"]);
  assert.equal(box.runs[0]?.cwd, "/repo/work");
  assert.equal(box.runs[0]?.stdin, "do the thing");
});

test("the pi adapter names the session and the model on a later turn", async () => {
  const box = await pi([]);

  await box.turn({ first: false, options: { model: "gpt-5" } });

  assert.deepEqual(box.runs[0]?.argv, [
    "pi",
    "--mode",
    "json",
    "--session-id",
    "s-1",
    "--model",
    "gpt-5",
  ]);
});

test("the pi adapter takes the result from the last penguin_result call", async () => {
  const schema = {
    type: "object",
    properties: { verdict: { type: "string" } },
    required: ["verdict"],
  };
  const box = await pi([
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "the tests pass." },
          { type: "toolCall", name: "penguin_result", arguments: { verdict: "changes_needed" } },
          { type: "toolCall", name: "penguin_result", arguments: { verdict: "approved" } },
        ],
        stopReason: "stop",
      },
    },
  ]);

  const result = await box.turn({ schema });

  assert.deepEqual(result, { ok: true, value: { verdict: "approved" } });
  assert.deepEqual(box.events, [
    { type: "agent", session: "s-1", kind: "text", text: "the tests pass." },
  ]);
  const argv = box.runs[0]?.argv ?? [];
  const written = String(argv[argv.indexOf("-e") + 1]);
  const extension = box.runs[0]?.extension ?? "";
  assert.ok(extension.includes(JSON.stringify(schema)), extension);
  assert.match(extension, /registerTool/);
  assert.equal(fs.existsSync(path.dirname(written)), false);
});

test("the pi adapter reports a schema turn that carries no result", async () => {
  const box = await pi([
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done." }],
        stopReason: "stop",
      },
    },
  ]);

  const result = await box.turn({ schema: { type: "object" } });

  assert.deepEqual(result, { ok: false, error: "pi returned no structured output" });
});

test("the pi adapter reports the error a message_end carries", async () => {
  const box = await pi([
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "reading the footer." }],
        stopReason: "error",
        errorMessage: "the provider refused the request",
      },
    },
  ]);

  const result = await box.turn();

  assert.deepEqual(result, { ok: false, error: "the provider refused the request" });
  assert.deepEqual(box.events, [
    { type: "agent", session: "s-1", kind: "text", text: "reading the footer." },
  ]);
});

test("the pi adapter reports the error an aborted stream carries", async () => {
  const box = await pi([
    { type: "message_update", assistantMessageEvent: { type: "error", error: {} } },
    {
      type: "message_update",
      assistantMessageEvent: { type: "error", error: { errorMessage: "the run was aborted" } },
    },
  ]);

  const result = await box.turn();

  assert.deepEqual(result, { ok: false, error: "the run was aborted" });
});

test("the pi adapter names an error that carries no message", async () => {
  const box = await pi([
    { type: "message_update", assistantMessageEvent: { type: "error", error: {} } },
  ]);

  const result = await box.turn();

  assert.deepEqual(result, { ok: false, error: "pi reported an error" });
});

test("the pi adapter reports a nonzero exit with the last stderr line", async () => {
  const box = await pi([], { code: 2, stderr: "warming up\nno model is configured\n" });

  const result = await box.turn();

  assert.deepEqual(result, { ok: false, error: "pi exited with code 2: no model is configured" });
});
