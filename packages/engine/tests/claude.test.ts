import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { CommandResult, ExecOptions, Host } from "../src/core/adapter.ts";
import definition from "../examples/adapters/claude.ts";

type Call = { argv: string[]; options: ExecOptions | undefined };

function fakeHost(
  handler: (call: Call, count: number) => Promise<CommandResult>,
  skill?: Host["skill"],
): { host: Host; calls: Call[]; notes: Record<string, unknown>[] } {
  const calls: Call[] = [];
  const notes: Record<string, unknown>[] = [];
  const host: Host = {
    cwd: "/",
    home: "/tmp",
    state: "/tmp",
    run: { id: "test", dir: "/tmp" },
    // Tests never wait out a real limit.
    config: (key) => (key === "limit-wait-seconds" ? "0" : undefined),
    secret: async () => undefined,
    note: (entry) => {
      notes.push(entry);
    },
    open: () => {},
    skill:
      skill ??
      (() => {
        throw new Error("no skills installed");
      }),
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

/** What claude streams when a turn dies on a usage limit. */
function limit(call: Call, kind: string, text: string): void {
  emit(call, {
    type: "assistant",
    is_api_error_message: true,
    error: kind,
    message: { content: [{ type: "text", text }] },
  });
  emit(call, { type: "result", subtype: "error_during_execution", is_error: true, errors: [text] });
}

const RESETS = "You've hit your session limit \u00b7 resets 3pm";

test("maps neutral model choices to claude models", async () => {
  for (const [model, expected] of [
    ["best", "fable"],
    ["big", "opus"],
    ["small", "sonnet"],
  ]) {
    const { host, calls } = fakeHost(async () => OK);
    const agent = definition.build(host);
    const session = await agent.open({ model });
    await agent.turn(session, "go").value;
    expect(calls[0]?.argv).toContain(expected);
  }
});

test("streams chunks and returns the schema-checked value", async () => {
  const { host } = fakeHost(async (call) => {
    emit(call, {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "picking files" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "git  status" } },
        ],
      },
    });
    emit(call, {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "clean tree" }],
      },
    });
    emit(call, { type: "result", structured_output: { n: 1 } });
    return OK;
  });
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, "go", { result: z.object({ n: z.number() }) });
  const chunks = [];
  for await (const chunk of turn.output) chunks.push(chunk);
  expect(await turn.value).toEqual({ n: 1 });
  expect(chunks).toEqual([
    { kind: "text", text: "picking files" },
    {
      kind: "tool",
      call: { id: "toolu_1", name: "Bash", kind: "run", status: "running", target: "git status" },
    },
    {
      kind: "tool",
      call: {
        id: "toolu_1",
        name: "Bash",
        kind: "run",
        status: "done",
        target: "git status",
        output: "clean tree",
      },
    },
  ]);
});

test("a rejected result retries once with a correction, resuming the session", async () => {
  const { host, calls } = fakeHost(async (call, count) => {
    emit(call, { type: "result", structured_output: { n: count === 1 ? "wrong" : 2 } });
    return OK;
  });
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, "go", { result: z.object({ n: z.number() }) });
  expect(await turn.value).toEqual({ n: 2 });
  expect(calls).toHaveLength(2);
  expect(calls[0]?.argv).toContain("--session-id");
  expect(calls[1]?.argv).toContain("--resume");
  expect(calls[1]?.options?.stdin).toContain("# Correction");
});

test("two failures throw instead of looping", async () => {
  const { host, calls } = fakeHost(async () => ({ code: 1, stdout: "", stderr: "boom\n" }));
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, "go");
  await expect(turn.value).rejects.toThrow("the turn failed twice");
  expect(calls).toHaveLength(2);
});

test("stop aborts the running turn and the session survives", async () => {
  const { host } = fakeHost(
    (call) =>
      new Promise((resolve) => {
        call.options?.signal?.addEventListener(
          "abort",
          () => resolve({ code: 1, stdout: "", stderr: "" }),
          { once: true },
        );
      }),
  );
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, "go");
  await agent.stop(session);
  await expect(turn.value).rejects.toThrow("the turn was stopped");
});

test("a skill ask sends the skill's instructions, then the prompt", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-skill-"));
  const { host, calls } = fakeHost(
    async () => OK,
    (name) => ({ name, description: "test skill", dir, text: "# The instructions" }),
  );
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, { skill: "commit", prompt: "the branch is main" });
  await turn.value;
  expect(calls[0]?.options?.stdin).toBe("# The instructions\n\nthe branch is main");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a skill with extra files says where they live", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-skill-"));
  fs.writeFileSync(path.join(dir, "REFERENCE.md"), "details\n");
  const { host, calls } = fakeHost(
    async () => OK,
    (name) => ({ name, description: "test skill", dir, text: "# The instructions" }),
  );
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, { skill: "commit" });
  await turn.value;
  expect(calls[0]?.options?.stdin).toBe(
    `# The instructions\n\nThis skill's files live in ${dir}.`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unknown skill fails the turn before the CLI runs", async () => {
  const { host, calls } = fakeHost(async () => OK);
  const agent = definition.build(host);
  const session = await agent.open();
  expect(() => agent.turn(session, { skill: "missing" })).toThrow("no skills installed");
  expect(calls).toHaveLength(0);
});

test("an unopened session is refused with the fix in the message", async () => {
  const { host } = fakeHost(async () => OK);
  const agent = definition.build(host);
  expect(() => agent.turn("nope", "go")).toThrow(/no open session/);
  await expect(agent.stop("nope")).rejects.toThrow(/no open session/);
});

test("a usage limit waits and reruns the turn instead of spending a retry", async () => {
  const { host, calls, notes } = fakeHost(async (call, count) => {
    if (count < 3) {
      limit(call, "rate_limit", RESETS);
      return OK;
    }
    emit(call, { type: "result", structured_output: { n: 7 } });
    return OK;
  });
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, "go", { result: z.object({ n: z.number() }) });
  expect(await turn.value).toEqual({ n: 7 });
  expect(calls).toHaveLength(3);
  expect(calls[0]?.argv).toContain("--session-id");
  expect(calls[1]?.argv).toContain("--resume");
  // The limit is not the agent's mistake, so the prompt is sent again untouched.
  expect(calls[2]?.options?.stdin).toBe("go");
  expect(notes).toEqual([
    { limit: { role: "agent", reason: RESETS } },
    { limit: { role: "agent", resolved: true } },
  ]);
});

test("the limit itself never reaches the story", async () => {
  const { host } = fakeHost(async (call, count) => {
    if (count === 1) {
      limit(call, "rate_limit", RESETS);
      return OK;
    }
    emit(call, { type: "assistant", message: { content: [{ type: "text", text: "back" }] } });
    emit(call, { type: "result" });
    return OK;
  });
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, "go");
  const chunks = [];
  for await (const chunk of turn.output) chunks.push(chunk);
  await turn.value;
  expect(chunks).toEqual([{ kind: "text", text: "back" }]);
});

test("a limit the CLI recovered from does not pause the turn", async () => {
  const { host, calls, notes } = fakeHost(async (call) => {
    emit(call, {
      type: "assistant",
      is_api_error_message: true,
      error: "rate_limit",
      message: { content: [{ type: "text", text: RESETS }] },
    });
    emit(call, { type: "result", structured_output: null });
    return OK;
  });
  const agent = definition.build(host);
  const session = await agent.open();
  await agent.turn(session, "go").value;
  expect(calls).toHaveLength(1);
  expect(notes).toEqual([]);
});

test("an error that no wait can clear still fails after two tries", async () => {
  const { host, calls, notes } = fakeHost(async (call) => {
    limit(call, "billing_error", "You're out of usage credits.");
    return OK;
  });
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, "go");
  await expect(turn.value).rejects.toThrow("You're out of usage credits.");
  expect(calls).toHaveLength(2);
  expect(notes).toEqual([]);
});

test("stop ends a turn that is waiting out a limit", async () => {
  const { host, notes } = fakeHost(async (call) => {
    limit(call, "rate_limit", RESETS);
    return OK;
  });
  // Long enough that only the stop can end the wait.
  host.config = (key) => (key === "limit-wait-seconds" ? "60" : undefined);
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, "go");
  await Bun.sleep(20);
  await agent.stop(session);
  await expect(turn.value).rejects.toThrow("the turn was stopped");
  expect(notes).toEqual([
    { limit: { role: "agent", reason: RESETS } },
    { limit: { role: "agent", resolved: true } },
  ]);
});

test("an error result without a result field says what claude reported", async () => {
  const { host } = fakeHost(async (call) => {
    emit(call, {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["the model refused", "and gave up"],
    });
    return OK;
  });
  const agent = definition.build(host);
  const session = await agent.open();
  await expect(agent.turn(session, "go").value).rejects.toThrow(
    "the model refused; and gave up",
  );
});
