import type { AgentAdapter, AgentTurn, Host, ViewEvent } from "@mikaelweiss/penguin-engine";
import { loadAdapter } from "@mikaelweiss/penguin-engine/catalog";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { runArgv } from "./helpers.ts";

const cursorFile = fileURLToPath(new URL("../packages/engine/examples/adapters/cursor.ts", import.meta.url));

type Call = { argv: string[]; cwd: string; stdin: string };

type Fake = {
  work: string;
  reply(plan: { out?: string; stderr?: string; code?: number }): void;
  calls(): Call[];
};

/** A cursor-agent on PATH that logs its call and prints the lines the case wants. */
function fakeCursor(t: TestContext): Fake {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "penguin-cursor-")));
  const work = path.join(dir, "work");
  const plan = path.join(dir, "plan.json");
  const log = path.join(dir, "calls.jsonl");
  fs.mkdirSync(work);
  fs.writeFileSync(plan, "{}");
  fs.writeFileSync(
    path.join(dir, "fake.mjs"),
    `import fs from "node:fs";
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(plan)}, "utf8"));
const stdin = fs.readFileSync(0, "utf8");
const call = { argv: process.argv.slice(2), cwd: process.cwd(), stdin };
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(call) + "\\n");
process.stdout.write(plan.out ?? "");
if (plan.stderr !== undefined) process.stderr.write(plan.stderr);
process.exit(plan.code ?? 0);
`,
  );
  fs.writeFileSync(
    path.join(dir, "cursor-agent"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(dir, "fake.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  const prior = process.env["PATH"];
  process.env["PATH"] = `${dir}${path.delimiter}${prior ?? ""}`;
  t.after(() => {
    process.env["PATH"] = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    work,
    reply(next) {
      fs.writeFileSync(plan, JSON.stringify(next));
    },
    calls() {
      if (!fs.existsSync(log)) return [];
      return fs
        .readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Call);
    },
  };
}

function stubHost(events: ViewEvent[]): Host {
  return {
    cwd: process.cwd(),
    shell: async () => ({ code: 0, stdout: "", stderr: "" }),
    exec: (argv, options) => runArgv(argv, options?.cwd ?? process.cwd(), options),
    wait: <T,>(_label: string, body: () => Promise<T>) => body(),
    emit: (event) => {
      events.push(event);
    },
    credential: (() => {
      throw new Error("the cursor adapter asks for no credential");
    }) as Host["credential"],
  };
}

async function cursor(events: ViewEvent[]): Promise<AgentAdapter> {
  const definition = await loadAdapter(cursorFile);
  return definition.build(stubHost(events)) as AgentAdapter;
}

function turnOf(over: Partial<AgentTurn>): AgentTurn {
  return { session: "s1", first: true, cwd: process.cwd(), prompt: "do it", options: {}, ...over };
}

function stream(...events: unknown[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

const result = (text: string, over: Record<string, unknown> = {}): unknown => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
  session_id: "chat-1",
  ...over,
});

test("the first turn opens a chat, and the argv carries the print flags", async (t) => {
  const fake = fakeCursor(t);
  const events: ViewEvent[] = [];
  const api = await cursor(events);
  fake.reply({
    out: stream(
      { type: "system", subtype: "init", session_id: "chat-1" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "looking" }] },
        session_id: "chat-1",
      },
      {
        type: "tool_call",
        subtype: "started",
        call_id: "c1",
        tool_call: { readToolCall: { args: { path: "src/a.ts" } } },
      },
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "c1",
        tool_call: { readToolCall: { args: { path: "src/a.ts" }, result: "10 lines" } },
      },
      result('here it is\n```json\n{"ok": true, "note": "a } brace"}\n```'),
    ),
  });

  const outcome = await api.turn(
    turnOf({ cwd: fake.work, schema: { type: "object" }, options: { model: "sonnet-4.5" } }),
  );

  assert.deepEqual(outcome, { ok: true, value: { ok: true, note: "a } brace" } });
  const [call] = fake.calls();
  assert.deepEqual(call?.argv, [
    "-p",
    "--force",
    "--output-format",
    "stream-json",
    "--model",
    "sonnet-4.5",
  ]);
  assert.equal(call?.cwd, fake.work);
  assert.equal(
    call?.stdin,
    'do it\n\nReply with one JSON object that matches this JSON Schema:\n{"type":"object"}\n',
  );
  assert.deepEqual(events, [
    { type: "agent", session: "s1", kind: "text", text: "looking" },
    { type: "agent", session: "s1", kind: "tool", text: "read", detail: "src/a.ts" },
  ]);
});

test("a tool call with no call id emits, because nothing tells two of them apart", async (t) => {
  const fake = fakeCursor(t);
  const events: ViewEvent[] = [];
  const api = await cursor(events);
  fake.reply({
    out: stream(
      { type: "tool_call", subtype: "started", tool_call: { readToolCall: { args: { path: "src/a.ts" } } } },
      { type: "tool_call", subtype: "started", tool_call: { shellToolCall: { args: { command: "bun test" } } } },
      result("done"),
    ),
  });

  await api.turn(turnOf({ cwd: fake.work }));

  assert.deepEqual(events, [
    { type: "agent", session: "s1", kind: "tool", text: "read", detail: "src/a.ts" },
    { type: "agent", session: "s1", kind: "tool", text: "shell", detail: "bun test" },
  ]);
});

test("a session with no recorded chat id starts a new chat, whatever first says", async (t) => {
  const fake = fakeCursor(t);
  const api = await cursor([]);
  fake.reply({ out: stream(result("done")) });

  await api.turn(turnOf({ cwd: fake.work, first: false }));

  assert.deepEqual(fake.calls()[0]?.argv, ["-p", "--force", "--output-format", "stream-json"]);
});

test("the last chat id a turn reports is the one the next turn resumes", async (t) => {
  const fake = fakeCursor(t);
  const api = await cursor([]);
  fake.reply({
    out: stream(
      { type: "system", subtype: "init", session_id: "chat-1" },
      result("done", { session_id: "chat-2" }),
    ),
  });

  await api.turn(turnOf({ cwd: fake.work }));
  await api.turn(turnOf({ cwd: fake.work, first: false }));

  assert.deepEqual(fake.calls()[1]?.argv, [
    "-p",
    "--force",
    "--output-format",
    "stream-json",
    "--resume",
    "chat-2",
  ]);
});

test("a turn that dies before any event opens a new chat next time", async (t) => {
  const fake = fakeCursor(t);
  const api = await cursor([]);
  fake.reply({ out: "", stderr: "logging in\nno credentials found\n", code: 2 });

  const outcome = await api.turn(turnOf({ cwd: fake.work }));
  fake.reply({ out: stream(result("done")) });
  await api.turn(turnOf({ cwd: fake.work, first: false }));

  assert.deepEqual(outcome, {
    ok: false,
    error: "cursor-agent exited with code 2: no credentials found",
  });
  assert.deepEqual(fake.calls()[1]?.argv, ["-p", "--force", "--output-format", "stream-json"]);
});

test("the chat ids never outlive the build that holds them", async (t) => {
  const fake = fakeCursor(t);
  fake.reply({ out: stream({ type: "system", subtype: "init", session_id: "chat-1" }, result("done")) });

  await (await cursor([])).turn(turnOf({ cwd: fake.work }));
  await (await cursor([])).turn(turnOf({ cwd: fake.work, first: false }));

  assert.deepEqual(fake.calls()[1]?.argv, ["-p", "--force", "--output-format", "stream-json"]);
});

test("a line that does not parse is ignored, and the tail with no newline is read once", async (t) => {
  const fake = fakeCursor(t);
  const events: ViewEvent[] = [];
  const api = await cursor(events);
  const tail = JSON.stringify(result('{"ok": true}'));
  fake.reply({
    out: `cursor-agent 1.2.3\n${stream({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    })}${tail}`,
  });

  const outcome = await api.turn(turnOf({ cwd: fake.work, schema: { type: "object" } }));

  assert.deepEqual(outcome, { ok: true, value: { ok: true } });
  assert.deepEqual(events, [{ type: "agent", session: "s1", kind: "text", text: "hello" }]);
});

test("a result with no JSON object fails and names what came back", async (t) => {
  const fake = fakeCursor(t);
  const api = await cursor([]);
  fake.reply({ out: stream(result("I read the file\nand stopped")) });

  const outcome = await api.turn(turnOf({ cwd: fake.work, schema: { type: "object" } }));

  assert.deepEqual(outcome, {
    ok: false,
    error: "cursor-agent returned no JSON object: I read the file and stopped",
  });
});

test("a turn with no schema returns null however much text the CLI printed", async (t) => {
  const fake = fakeCursor(t);
  const api = await cursor([]);
  fake.reply({ out: stream(result('the answer is {"ok": true}')) });

  const outcome = await api.turn(turnOf({ cwd: fake.work }));

  assert.deepEqual(outcome, { ok: true, value: null });
  assert.equal(fake.calls()[0]?.stdin, "do it");
});

test("a result the CLI marks as an error fails with the text it gave", async (t) => {
  const fake = fakeCursor(t);
  const api = await cursor([]);
  fake.reply({ out: stream(result("the model is over its rate limit", { subtype: "error", is_error: true })) });

  const outcome = await api.turn(turnOf({ cwd: fake.work, schema: { type: "object" } }));

  assert.deepEqual(outcome, { ok: false, error: "the model is over its rate limit" });
});
