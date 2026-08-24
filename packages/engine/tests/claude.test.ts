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
): { host: Host; calls: Call[] } {
  const calls: Call[] = [];
  const host: Host = {
    cwd: "/",
    home: "/tmp",
    state: "/tmp",
    run: { id: "test", dir: "/tmp" },
    config: () => undefined,
    skill:
      skill ??
      (() => {
        throw new Error("no skills installed");
      }),
    shell: async () => ({ code: 0, stdout: "", stderr: "" }),
    exec: (argv, options) => {
      const call = { argv, options };
      calls.push(call);
      return handler(call, calls.length);
    },
  };
  return { host, calls };
}

function emit(call: Call, event: unknown): void {
  call.options?.onOutput?.(`${JSON.stringify(event)}\n`, "stdout");
}

const OK: CommandResult = { code: 0, stdout: "", stderr: "" };

test("streams chunks and returns the schema-checked value", async () => {
  const { host } = fakeHost(async (call) => {
    emit(call, {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "picking files" },
          { type: "tool_use", name: "Bash", input: { command: "git  status" } },
        ],
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
    { kind: "tool", text: "Bash", detail: "git status" },
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
