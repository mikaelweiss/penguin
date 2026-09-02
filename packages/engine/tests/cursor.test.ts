import { expect, test } from "bun:test";
import type { CommandResult, ExecOptions, Host } from "../src/core/adapter.ts";
import definition from "../examples/adapters/cursor.ts";

type Call = { argv: string[]; options: ExecOptions | undefined };

function fakeHost(handler: (call: Call) => Promise<CommandResult>): {
  host: Host;
  calls: Call[];
  notes: Record<string, unknown>[];
} {
  const calls: Call[] = [];
  const notes: Record<string, unknown>[] = [];
  const host: Host = {
    cwd: "/",
    home: "/tmp",
    state: "/tmp",
    run: { id: "test", dir: "/tmp" },
    config: (key) => (key === "limit-wait-seconds" ? "0" : undefined),
    secret: async () => undefined,
    note: (entry) => {
      notes.push(entry);
    },
    open: () => {},
    skill: () => {
      throw new Error("no skills installed");
    },
    spawn: () => {
      throw new Error("no spawn in this test");
    },
    shell: async () => ({ code: 0, stdout: "", stderr: "" }),
    exec: (argv, options) => {
      const call = { argv, options };
      calls.push(call);
      return handler(call);
    },
  };
  return { host, calls, notes };
}

function emit(call: Call, event: unknown): void {
  call.options?.onOutput?.(`${JSON.stringify(event)}\n`, "stdout");
}

const OK: CommandResult = { code: 0, stdout: "", stderr: "" };

test("maps neutral model choices to cursor models, with normal as the fallback", async () => {
  for (const [model, expected] of [
    ["small", "cursor-grok-4.6-low"],
    ["normal", "cursor-grok-4.6-medium"],
    ["big", "cursor-grok-4.6-high"],
    [undefined, "cursor-grok-4.6-medium"],
  ] as const) {
    const { host, calls } = fakeHost(async () => OK);
    const agent = definition.build(host);
    const session = await agent.open(model === undefined ? {} : { model });
    await agent.turn(session, "go").value;
    expect(calls[0]?.argv).toContain(expected);
  }
});

test("reads the camelCase token names cursor actually reports", async () => {
  const { host, notes } = fakeHost(async (call) => {
    emit(call, {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      usage: { inputTokens: 11952, outputTokens: 31, cacheReadTokens: 5760, cacheWriteTokens: 4 },
    });
    return OK;
  });
  const agent = definition.build(host);
  const session = await agent.open({});
  await agent.turn(session, "go").value;
  const usage = notes.find((entry) => "usage" in entry)?.["usage"] as Record<string, number>;
  expect(usage).toMatchObject({ input: 11952, output: 31, cacheRead: 5760, cacheWrite: 4 });
});
