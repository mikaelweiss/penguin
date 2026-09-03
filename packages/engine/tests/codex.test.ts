import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandResult, ExecOptions, Host } from "../src/core/adapter.ts";
import definition from "../examples/adapters/codex.ts";

type Call = { argv: string[]; options: ExecOptions | undefined };

const OK: CommandResult = { code: 0, stdout: "", stderr: "" };

function fakeHost(): { host: Host; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    host: {
      cwd: "/",
      home: "/tmp",
      state: "/tmp",
      run: { id: "test", dir: fs.mkdtempSync(path.join(os.tmpdir(), "penguin-codex-")) },
      config: () => undefined,
      secret: async () => undefined,
      note: () => {},
      open: () => {},
      skill: () => {
        throw new Error("no skills installed");
      },
      spawn: () => {
        throw new Error("no spawn in this test");
      },
      shell: async () => OK,
      exec: async (argv, options) => {
        calls.push({ argv, options });
        return OK;
      },
    },
  };
}

test("maps neutral model choices to codex models", async () => {
  for (const [model, expected] of [
    ["small", "gpt-5.6-terra"],
    ["normal", "gpt-5.6-sol"],
    ["big", "gpt-5.6-sol"],
  ]) {
    const { host, calls } = fakeHost();
    const agent = definition.build(host);
    const session = await agent.open({ model });
    await agent.turn(session, "go").value;
    expect(calls[0]?.argv).toContain(`model="${expected}"`);
  }
});

test("an autocompact size becomes codex's own auto-compact token limit", async () => {
  for (const [size, limit] of [
    ["200000", "200000"],
    ["200k", "200000"],
    ["1M", "1000000"],
  ]) {
    const { host, calls } = fakeHost();
    const agent = definition.build(host);
    const session = await agent.open({ autocompact: size });
    await agent.turn(session, "go").value;
    expect(calls[0]?.argv).toContain(`model_auto_compact_token_limit=${limit}`);
  }
});

test("an autocompact naming no count leaves codex the limit it chose for the model", async () => {
  for (const size of ["auto", ""]) {
    const { host, calls } = fakeHost();
    const agent = definition.build(host);
    const session = await agent.open({ autocompact: size });
    await agent.turn(session, "go").value;
    expect(calls[0]?.argv.join(" ")).not.toContain("model_auto_compact_token_limit");
  }
});

test("a session that asks for no compaction passes no limit", async () => {
  const { host, calls } = fakeHost();
  const agent = definition.build(host);
  const session = await agent.open({});
  await agent.turn(session, "go").value;
  expect(calls[0]?.argv.join(" ")).not.toContain("model_auto_compact_token_limit");
});

test("a later turn resumes the thread the first one started, in this process or the next", async () => {
  const { host, calls } = fakeHost();
  host.exec = async (argv, options) => {
    calls.push({ argv, options });
    options?.onOutput?.(`${JSON.stringify({ type: "thread.started", thread_id: "t-1" })}\n`, "stdout");
    return OK;
  };
  const agent = definition.build(host);
  const session = await agent.open();
  await agent.turn(session, "go").value;
  await agent.turn(session, "again").value;
  expect(calls[0]?.argv.slice(0, 2)).toEqual(["codex", "exec"]);
  expect(calls[1]?.argv.slice(0, 4)).toEqual(["codex", "exec", "resume", "t-1"]);

  const later = definition.build(host);
  await later.turn(session, "once more").value;
  expect(calls[2]?.argv.slice(0, 4)).toEqual(["codex", "exec", "resume", "t-1"]);
});

test("an autocompact size becomes codex's own auto-compact token limit", async () => {
  for (const [size, limit] of [
    ["200000", "200000"],
    ["200k", "200000"],
    ["1M", "1000000"],
  ]) {
    const { host, calls } = fakeHost();
    const agent = definition.build(host);
    const session = await agent.open({ autocompact: size });
    await agent.turn(session, "go").value;
    expect(calls[0]?.argv).toContain(`model_auto_compact_token_limit=${limit}`);
  }
});

test("an autocompact naming no count leaves codex the limit it chose for the model", async () => {
  for (const size of ["auto", ""]) {
    const { host, calls } = fakeHost();
    const agent = definition.build(host);
    const session = await agent.open({ autocompact: size });
    await agent.turn(session, "go").value;
    expect(calls[0]?.argv.join(" ")).not.toContain("model_auto_compact_token_limit");
  }
});

test("a session that asks for no compaction passes no limit", async () => {
  const { host, calls } = fakeHost();
  const agent = definition.build(host);
  const session = await agent.open({});
  await agent.turn(session, "go").value;
  expect(calls[0]?.argv.join(" ")).not.toContain("model_auto_compact_token_limit");
});
