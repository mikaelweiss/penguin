import { expect, test } from "bun:test";
import { z } from "zod";
import type { CommandResult, ExecOptions, Host } from "../src/core/adapter.ts";
import definition from "../examples/adapters/copilot.ts";

type Call = { argv: string[]; options: ExecOptions | undefined };

function fakeHost(
  handler: (call: Call, count: number) => Promise<CommandResult>,
): { host: Host; calls: Call[]; notes: Record<string, unknown>[] } {
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
      return handler(call, calls.length);
    },
  };
  return { host, calls, notes };
}

function emit(call: Call, event: unknown): void {
  call.options?.onOutput?.(`${JSON.stringify(event)}\n`, "stdout");
}

const OK: CommandResult = { code: 0, stdout: "", stderr: "" };

const RESETS = "You've hit your session limit · resets 3pm";

test("maps neutral model choices to copilot models", async () => {
  for (const [model, expected] of [
    ["small", "claude-haiku-4.5"],
    ["normal", "claude-sonnet-4.6"],
    ["big", "gpt-5.3-codex"],
  ]) {
    const { host, calls } = fakeHost(async () => OK);
    const agent = definition.build(host);
    const session = await agent.open({ model });
    await agent.turn(session, "go").value;
    expect(calls[0]?.argv).toContain(expected);
  }
});

test("drives the CLI unattended: json stream, autopilot, allow-all, one session id", async () => {
  const { host, calls } = fakeHost(async () => OK);
  const agent = definition.build(host);
  const session = await agent.open();
  await agent.turn(session, "go").value;
  const argv = calls[0]?.argv ?? [];
  expect(argv[0]).toBe("copilot");
  expect(argv).toContain("--output-format");
  expect(argv).toContain("json");
  expect(argv).toContain("--allow-all");
  expect(argv).toContain("--no-ask-user");
  expect(argv).toContain("--mode");
  expect(argv).toContain("autopilot");
  expect(argv).toContain("--session-id");
  expect(argv).toContain(session);
  expect(argv).toContain("-p");
  expect(argv).toContain("go");
});

test("streams chunks and returns the schema-checked value", async () => {
  const { host } = fakeHost(async (call) => {
    emit(call, {
      type: "assistant.reasoning",
      data: { content: "look at git" },
    });
    emit(call, {
      type: "assistant.message",
      data: { content: "picking files" },
    });
    emit(call, {
      type: "tool.execution_start",
      data: { toolCallId: "t1", toolName: "bash", arguments: { command: "git  status" } },
    });
    emit(call, {
      type: "tool.execution_complete",
      data: { toolCallId: "t1", success: true, result: { content: "clean tree" } },
    });
    emit(call, {
      type: "assistant.message",
      data: { content: '{"n":1}' },
    });
    return OK;
  });
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, "go", { result: z.object({ n: z.number() }) });
  const chunks = [];
  for await (const chunk of turn.output) chunks.push(chunk);
  expect(await turn.value).toEqual({ n: 1 });
  expect(chunks).toEqual([
    { kind: "thinking", text: "look at git" },
    { kind: "text", text: "picking files" },
    {
      kind: "tool",
      call: { id: "t1", name: "bash", kind: "run", status: "running", target: "git status" },
    },
    {
      kind: "tool",
      call: {
        id: "t1",
        name: "bash",
        kind: "run",
        status: "done",
        target: "git status",
        output: "clean tree",
      },
    },
    { kind: "text", text: '{"n":1}' },
  ]);
});

test("a rejected result retries once with a correction, same session id", async () => {
  const { host, calls } = fakeHost(async (call, count) => {
    emit(call, { type: "assistant.message", data: { content: count === 1 ? "wrong" : '{"n":2}' } });
    return OK;
  });
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, "go", { result: z.object({ n: z.number() }) });
  expect(await turn.value).toEqual({ n: 2 });
  expect(calls).toHaveLength(2);
  expect(calls[0]?.argv).toContain(session);
  expect(calls[1]?.argv).toContain(session);
  expect(calls[1]?.argv.some((arg) => arg.includes("# Correction"))).toBe(true);
});

test("a usage limit waits and reruns the turn instead of spending a retry", async () => {
  const { host, calls, notes } = fakeHost(async (call, count) => {
    if (count < 3) {
      emit(call, { type: "session.error", data: { errorType: "rate_limit", message: RESETS } });
      return OK;
    }
    emit(call, { type: "assistant.message", data: { content: '{"n":7}' } });
    return OK;
  });
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, "go", { result: z.object({ n: z.number() }) });
  expect(await turn.value).toEqual({ n: 7 });
  expect(calls).toHaveLength(3);
  expect(calls[2]?.argv.some((arg) => arg.includes("# Correction"))).toBe(false);
  expect(notes).toEqual([
    { limit: { role: "agent", reason: RESETS } },
    { limit: { role: "agent", resolved: true } },
  ]);
});
