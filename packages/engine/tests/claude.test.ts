import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { CommandResult, Host, Process, SpawnOptions } from "../src/core/adapter.ts";
import definition from "../examples/adapters/claude.ts";

/** One spawned claude process: its argv, what the adapter wrote to it, and how it ended. */
type Call = {
  argv: string[];
  options: SpawnOptions | undefined;
  written: string[];
  ended: boolean;
  exit: (done: CommandResult) => void;
};

/** What the test does when the adapter sends a prompt: emit events, exit, or sit still. */
type OnPrompt = (call: Call, prompt: string, sent: number) => void;

function fakeHost(
  onPrompt: OnPrompt,
  skill?: Host["skill"],
): { host: Host; calls: Call[]; notes: Record<string, unknown>[] } {
  const calls: Call[] = [];
  const notes: Record<string, unknown>[] = [];
  let sent = 0;
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
    shell: async () => ({ code: 0, stdout: "", stderr: "" }),
    exec: async () => {
      throw new Error("the claude adapter spawns, it does not exec");
    },
    spawn: (argv, options) => {
      let settle: (done: CommandResult) => void = () => {};
      const exited = new Promise<CommandResult>((resolve) => {
        settle = resolve;
      });
      const call: Call = {
        argv,
        options,
        written: [],
        ended: false,
        exit: (done) => settle(done),
      };
      calls.push(call);
      options?.signal?.addEventListener("abort", () => call.exit({ code: 143, stdout: "", stderr: "" }), {
        once: true,
      });
      const child: Process = {
        write: (text) => {
          call.written.push(text);
          const line = JSON.parse(text) as { message: { content: string } };
          sent += 1;
          onPrompt(call, line.message.content, sent);
        },
        end: () => {
          call.ended = true;
          call.exit({ code: 0, stdout: "", stderr: "" });
        },
        exited,
      };
      return child;
    },
  };
  return { host, calls, notes };
}

function emit(call: Call, event: unknown): void {
  call.options?.onOutput?.(`${JSON.stringify(event)}\n`, "stdout");
}

/** The prompt text behind the nth line the adapter wrote to a process. */
function prompt(call: Call | undefined, index = 0): string | undefined {
  const line = call?.written[index];
  if (line === undefined) return undefined;
  return (JSON.parse(line) as { message: { content: string } }).message.content;
}

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

const RESETS = "You've hit your session limit · resets 3pm";

test("maps neutral model choices to claude models", async () => {
  for (const [model, expected] of [
    ["best", "fable"],
    ["big", "opus"],
    ["small", "sonnet"],
  ]) {
    const { host, calls } = fakeHost((call) => emit(call, { type: "result" }));
    const agent = definition.build(host);
    const session = await agent.open({ model });
    await agent.turn(session, "go").value;
    expect(calls[0]?.argv).toContain(expected);
  }
});

test("the prompt goes in as one stream-json user line on a process kept open", async () => {
  const { host, calls } = fakeHost((call) => emit(call, { type: "result" }));
  const agent = definition.build(host);
  const session = await agent.open();
  await agent.turn(session, "go").value;
  await agent.turn(session, "again").value;
  expect(calls).toHaveLength(1);
  expect(calls[0]?.argv).toEqual(
    expect.arrayContaining(["--input-format", "stream-json", "--session-id", session]),
  );
  expect(JSON.parse(calls[0]?.written[0] ?? "")).toEqual({
    type: "user",
    message: { role: "user", content: "go" },
  });
  expect(prompt(calls[0], 1)).toBe("again");
  expect(calls[0]?.ended).toBe(false);
});

test("the cache tier rides in the environment, and config overrides it", async () => {
  const { host, calls } = fakeHost((call) => emit(call, { type: "result" }));
  const agent = definition.build(host);
  await agent.turn(await agent.open(), "go").value;
  expect(calls[0]?.options?.env).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" });

  host.config = (key) => (key === "claude-cache-ttl" ? "1h" : "0");
  const configured = definition.build(host);
  await configured.turn(await configured.open(), "go").value;
  expect(calls[1]?.options?.env).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" });
});

test("streams chunks and returns the schema-checked value", async () => {
  const { host } = fakeHost((call) => {
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

test("a rejected result retries once with a correction on the same process", async () => {
  const { host, calls } = fakeHost((call, _prompt, sent) => {
    emit(call, { type: "result", structured_output: { n: sent === 1 ? "wrong" : 2 } });
  });
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, "go", { result: z.object({ n: z.number() }) });
  expect(await turn.value).toEqual({ n: 2 });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.written).toHaveLength(2);
  expect(prompt(calls[0], 1)).toContain("# Correction");
});

test("a process that dies mid-turn fails the turn, and the retry resumes the session", async () => {
  const { host, calls } = fakeHost((call, _prompt, sent) => {
    if (sent === 1) {
      call.exit({ code: 1, stdout: "", stderr: "boom\n" });
      return;
    }
    emit(call, { type: "result", structured_output: { n: 3 } });
  });
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, "go", { result: z.object({ n: z.number() }) });
  expect(await turn.value).toEqual({ n: 3 });
  expect(calls).toHaveLength(2);
  expect(calls[0]?.argv).toContain("--session-id");
  expect(calls[1]?.argv).toContain("--resume");
  expect(prompt(calls[1], 0)).toContain("claude exited with code 1: boom");
});

test("two failures throw instead of looping", async () => {
  const { host, calls } = fakeHost((call) => call.exit({ code: 1, stdout: "", stderr: "boom\n" }));
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, "go");
  await expect(turn.value).rejects.toThrow("the turn failed twice");
  expect(calls).toHaveLength(2);
});

test("a new schema ends the process and the next turn resumes by id", async () => {
  const { host, calls } = fakeHost((call) => emit(call, { type: "result", structured_output: { n: 1 } }));
  const agent = definition.build(host);
  const session = await agent.open();
  await agent.turn(session, "typed", { result: z.object({ n: z.number() }) }).value;
  await agent.turn(session, "plain").value;
  await agent.turn(session, "plain again").value;
  expect(calls).toHaveLength(2);
  expect(calls[0]?.argv).toContain("--json-schema");
  expect(calls[0]?.ended).toBe(true);
  expect(calls[1]?.argv).not.toContain("--json-schema");
  expect(calls[1]?.argv).toContain("--resume");
  expect(calls[1]?.written).toHaveLength(2);
});

test("stop aborts the running turn and the session survives", async () => {
  const { host, calls } = fakeHost(() => {});
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, "go");
  await agent.stop(session);
  await expect(turn.value).rejects.toThrow("the turn was stopped");
  expect(calls[0]?.options?.signal?.aborted).toBe(true);
});

test("a turn notes its own tokens and the cost grown since the last result", async () => {
  const { host, notes } = fakeHost((call, _prompt, sent) => {
    emit(call, {
      type: "result",
      usage: {
        input_tokens: 10 * sent,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
        output_tokens: 50,
      },
      total_cost_usd: sent === 1 ? 0.5 : 0.8,
      modelUsage: {
        "claude-opus-5": { inputTokens: 10 * sent, outputTokens: 50 * sent },
        "claude-haiku-4-5": { inputTokens: 1, outputTokens: 1 },
      },
    });
  }, (name) => ({ name, description: "test skill", dir: "/tmp", text: "# Review" }));
  const agent = definition.build(host);
  const session = await agent.open();
  await agent.turn(session, { skill: "review", prompt: "go" }).value;
  await agent.turn(session, "on").value;
  expect(notes).toEqual([
    {
      usage: {
        adapter: "claude",
        session,
        skill: "review",
        model: "claude-opus-5",
        input: 10,
        cacheRead: 1000,
        cacheWrite: 200,
        output: 50,
        usd: 0.5,
      },
    },
    {
      usage: {
        adapter: "claude",
        session,
        model: "claude-opus-5",
        input: 20,
        cacheRead: 1000,
        cacheWrite: 200,
        output: 50,
        usd: 0.3,
      },
    },
  ]);
});

test("a result without usage writes no note", async () => {
  const { host, notes } = fakeHost((call) => emit(call, { type: "result" }));
  const agent = definition.build(host);
  await agent.turn(await agent.open(), "go").value;
  expect(notes).toEqual([]);
});

test("a skill ask sends the skill's instructions, then the prompt", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-skill-"));
  const { host, calls } = fakeHost(
    (call) => emit(call, { type: "result" }),
    (name) => ({ name, description: "test skill", dir, text: "# The instructions" }),
  );
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, { skill: "commit", prompt: "the branch is main" });
  await turn.value;
  expect(prompt(calls[0])).toBe("# The instructions\n\nthe branch is main");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a skill with extra files says where they live", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-skill-"));
  fs.writeFileSync(path.join(dir, "REFERENCE.md"), "details\n");
  const { host, calls } = fakeHost(
    (call) => emit(call, { type: "result" }),
    (name) => ({ name, description: "test skill", dir, text: "# The instructions" }),
  );
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, { skill: "commit" });
  await turn.value;
  expect(prompt(calls[0])).toBe(`# The instructions\n\nThis skill's files live in ${dir}.`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unknown skill fails the turn before the CLI runs", async () => {
  const { host, calls } = fakeHost((call) => emit(call, { type: "result" }));
  const agent = definition.build(host);
  const session = await agent.open();
  expect(() => agent.turn(session, { skill: "missing" })).toThrow("no skills installed");
  expect(calls).toHaveLength(0);
});

test("an unopened session is refused with the fix in the message", async () => {
  const { host } = fakeHost((call) => emit(call, { type: "result" }));
  const agent = definition.build(host);
  expect(() => agent.turn("nope", "go")).toThrow(/no open session/);
  await expect(agent.stop("nope")).rejects.toThrow(/no open session/);
});

test("a usage limit waits and reruns the turn instead of spending a retry", async () => {
  const { host, calls, notes } = fakeHost((call, _prompt, sent) => {
    if (sent < 3) {
      limit(call, "rate_limit", RESETS);
      return;
    }
    emit(call, { type: "result", structured_output: { n: 7 } });
  });
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, "go", { result: z.object({ n: z.number() }) });
  expect(await turn.value).toEqual({ n: 7 });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.written).toHaveLength(3);
  // The limit is not the agent's mistake, so the prompt is sent again untouched.
  expect(prompt(calls[0], 2)).toBe("go");
  expect(notes).toEqual([
    { limit: { role: "agent", reason: RESETS } },
    { limit: { role: "agent", resolved: true } },
  ]);
});

test("the limit itself never reaches the story", async () => {
  const { host } = fakeHost((call, _prompt, sent) => {
    if (sent === 1) {
      limit(call, "rate_limit", RESETS);
      return;
    }
    emit(call, { type: "assistant", message: { content: [{ type: "text", text: "back" }] } });
    emit(call, { type: "result" });
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
  const { host, calls, notes } = fakeHost((call) => {
    emit(call, {
      type: "assistant",
      is_api_error_message: true,
      error: "rate_limit",
      message: { content: [{ type: "text", text: RESETS }] },
    });
    emit(call, { type: "result", structured_output: null });
  });
  const agent = definition.build(host);
  const session = await agent.open();
  await agent.turn(session, "go").value;
  expect(calls[0]?.written).toHaveLength(1);
  expect(notes).toEqual([]);
});

test("an error that no wait can clear still fails after two tries", async () => {
  const { host, calls, notes } = fakeHost((call) => {
    limit(call, "billing_error", "You're out of usage credits.");
  });
  const agent = definition.build(host);
  const session = await agent.open();
  const turn = agent.turn(session, "go");
  await expect(turn.value).rejects.toThrow("You're out of usage credits.");
  expect(calls[0]?.written).toHaveLength(2);
  expect(notes).toEqual([]);
});

test("stop ends a turn that is waiting out a limit", async () => {
  const { host, notes } = fakeHost((call) => {
    limit(call, "rate_limit", RESETS);
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
  const { host } = fakeHost((call) => {
    emit(call, {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["the model refused", "and gave up"],
    });
  });
  const agent = definition.build(host);
  const session = await agent.open();
  await expect(agent.turn(session, "go").value).rejects.toThrow(
    "the model refused; and gave up",
  );
});
