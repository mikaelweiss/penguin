import { expect, test } from "bun:test";
import type { CommandResult, ExecOptions, Host } from "../src/core/adapter.ts";
import codex from "../examples/adapters/codex.ts";
import cursor from "../examples/adapters/cursor.ts";
import opencode from "../examples/adapters/opencode.ts";
import pi from "../examples/adapters/pi.ts";

const OK: CommandResult = { code: 0, stdout: "", stderr: "" };

/** A host whose exec streams the given events to the adapter, then exits clean. */
function hostStreaming(
  events: unknown[],
  config: Record<string, string> = {},
): { host: Host; notes: Record<string, unknown>[] } {
  const notes: Record<string, unknown>[] = [];
  const host: Host = {
    cwd: "/",
    home: "/tmp",
    state: "/tmp",
    run: { id: "test", dir: "/tmp" },
    config: (key) => config[key],
    secret: async () => undefined,
    note: (entry) => {
      notes.push(entry);
    },
    open: () => {},
    skill: () => {
      throw new Error("no skills installed");
    },
    shell: async () => OK,
    exec: async (_argv: string[], options?: ExecOptions) => {
      for (const event of events) options?.onOutput?.(`${JSON.stringify(event)}\n`, "stdout");
      return OK;
    },
    spawn: () => {
      throw new Error("no spawn in this test");
    },
  };
  return { host, notes };
}

test("codex notes the turn's tokens, input net of the cached ones, priced from config", async () => {
  const { host, notes } = hostStreaming(
    [
      { type: "thread.started", thread_id: "t1" },
      {
        type: "turn.completed",
        usage: { input_tokens: 1500, cached_input_tokens: 1000, output_tokens: 20 },
      },
    ],
    { "price-gpt-5.6-sol": "2,0.5,10" },
  );
  const agent = codex.build(host);
  const session = await agent.open({ model: "big" });
  await agent.turn(session, "go").value;
  expect(notes).toEqual([
    {
      usage: {
        adapter: "codex",
        session,
        model: "gpt-5.6-sol",
        input: 500,
        cacheRead: 1000,
        cacheWrite: 0,
        output: 20,
        // 500 * 2 + 1000 * 0.5 + 20 * 10, over a million
        usd: 0.0017,
      },
    },
  ]);
});

test("codex without a price line notes tokens and no dollars", async () => {
  const { host, notes } = hostStreaming([
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } },
  ]);
  const agent = codex.build(host);
  await agent.turn(await agent.open(), "go").value;
  expect(notes[0]?.["usage"]).not.toHaveProperty("usd");
});

test("opencode sums its steps' tokens and cost into one note", async () => {
  const { host, notes } = hostStreaming([
    { type: "step_start", sessionID: "s1", part: { type: "step-start" } },
    {
      type: "step_finish",
      sessionID: "s1",
      part: { type: "step-finish", cost: 0.01, tokens: { input: 100, output: 10, cache: { read: 50, write: 5 } } },
    },
    { type: "text", sessionID: "s1", part: { type: "text", text: "done" } },
    {
      type: "step_finish",
      sessionID: "s1",
      part: { type: "step-finish", cost: 0.02, tokens: { input: 200, output: 20, cache: { read: 60, write: 0 } } },
    },
  ]);
  const agent = opencode.build(host);
  const session = await agent.open({ model: "anthropic/claude-opus-5" });
  await agent.turn(session, "go").value;
  expect(notes).toEqual([
    {
      usage: {
        adapter: "opencode",
        session,
        model: "anthropic/claude-opus-5",
        input: 300,
        cacheRead: 110,
        cacheWrite: 5,
        output: 30,
        usd: 0.03,
      },
    },
  ]);
});

test("pi sums its assistant messages' usage and names the model that answered", async () => {
  const message = (usage: Record<string, unknown>) => ({
    type: "message_end",
    message: {
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text: "hi" }],
      stopReason: "stop",
      usage,
    },
  });
  const { host, notes } = hostStreaming([
    message({ input: 10, output: 5, cacheRead: 100, cacheWrite: 20, cost: { total: 0.004 } }),
    message({ input: 12, output: 7, cacheRead: 130, cacheWrite: 0, cost: { total: 0.006 } }),
  ]);
  const agent = pi.build(host);
  const session = await agent.open();
  await agent.turn(session, "go").value;
  expect(notes).toEqual([
    {
      usage: {
        adapter: "pi",
        session,
        model: "claude-opus-5",
        input: 22,
        cacheRead: 230,
        cacheWrite: 20,
        output: 12,
        usd: 0.01,
      },
    },
  ]);
});

test("cursor notes the result event's usage, priced from config, and nothing without one", async () => {
  const { host, notes } = hostStreaming(
    [
      { type: "system", session_id: "c1" },
      {
        type: "result",
        result: "ok",
        // cursor spells these in camelCase, unlike every other CLI here.
        usage: {
          inputTokens: 400,
          cacheReadTokens: 1000,
          cacheWriteTokens: 100,
          outputTokens: 50,
        },
      },
    ],
    { "price-cursor-grok-4.6-medium": "1,0.1,4" },
  );
  const agent = cursor.build(host);
  const session = await agent.open();
  await agent.turn(session, "go").value;
  expect(notes).toEqual([
    {
      usage: {
        adapter: "cursor",
        session,
        model: "cursor-grok-4.6-medium",
        input: 400,
        cacheRead: 1000,
        cacheWrite: 100,
        output: 50,
        // 400 * 1 + 100 * 1.25 (the cache write's premium) + 1000 * 0.1 + 50 * 4, over a million
        usd: 0.000825,
      },
    },
  ]);

  const quiet = hostStreaming([{ type: "result", result: "ok" }]);
  const silent = cursor.build(quiet.host);
  await silent.turn(await silent.open(), "go").value;
  expect(quiet.notes).toEqual([]);
});
