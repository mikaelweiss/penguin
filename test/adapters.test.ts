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
    state: process.cwd(),
    catalogs: [],
    shell: async () => ({ code: 0, stdout: "", stderr: "" }),
    exec: (argv, options) => runArgv(argv, options?.cwd ?? process.cwd(), options),
    wait: <T,>(_label: string, body: () => Promise<T>) => body(),
    emit: (event) => {
      events.push(event);
    },
    gate: (() => {
      throw new Error("the cursor adapter asks no gate");
    }) as Host["gate"],
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
    "--trust",
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

  assert.deepEqual(fake.calls()[0]?.argv, [
    "-p",
    "--force",
    "--output-format",
    "stream-json",
    "--trust",
    "--model",
    "grok-4.6",
  ]);
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
    "--trust",
    "--resume",
    "chat-2",
    "--model",
    "grok-4.6",
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
  assert.deepEqual(fake.calls()[1]?.argv, [
    "-p",
    "--force",
    "--output-format",
    "stream-json",
    "--trust",
    "--model",
    "grok-4.6",
  ]);
});

test("the chat ids never outlive the build that holds them", async (t) => {
  const fake = fakeCursor(t);
  fake.reply({ out: stream({ type: "system", subtype: "init", session_id: "chat-1" }, result("done")) });

  await (await cursor([])).turn(turnOf({ cwd: fake.work }));
  await (await cursor([])).turn(turnOf({ cwd: fake.work, first: false }));

  assert.deepEqual(fake.calls()[1]?.argv, [
    "-p",
    "--force",
    "--output-format",
    "stream-json",
    "--trust",
    "--model",
    "grok-4.6",
  ]);
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

const ghFile = fileURLToPath(new URL("../packages/engine/examples/adapters/gh.ts", import.meta.url));

type Shelled = { code: number; stdout?: string; stderr?: string };

type Github = {
  pr: {
    create(options?: { cwd?: string; title?: string; body?: string }): Promise<{
      ok: boolean;
      url: string;
      existed: boolean;
      reason: string;
    }>;
    approve(pr: string): Promise<{ ok: boolean; reason: string }>;
  };
};

type GhBox = { api: Github; commands: string[]; stdins: string[]; asked: string[] };

/** A gh whose every call is scripted, and a user who answers each gate in turn. */
async function gh(replies: Shelled[], answers: string[]): Promise<GhBox> {
  const commands: string[] = [];
  const stdins: string[] = [];
  const asked: string[] = [];
  const host: Host = {
    cwd: process.cwd(),
    state: process.cwd(),
    catalogs: [],
    shell: async (cmd, options) => {
      commands.push(cmd);
      stdins.push(options?.stdin ?? "");
      const next = replies.shift() ?? { code: 0 };
      return { code: next.code, stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
    },
    exec: async () => 0,
    wait: <T,>(_label: string, body: () => Promise<T>) => body(),
    emit: () => {},
    gate: (async (question: string) => {
      asked.push(question);
      return answers.shift() ?? "done";
    }) as Host["gate"],
    credential: (() => {
      throw new Error("the gh adapter asks for no credential");
    }) as Host["credential"],
  };
  const definition = await loadAdapter(ghFile);
  return { api: definition.build(host) as Github, commands, stdins, asked };
}

test("a signed out gh holds the call at a gate and runs it again", async () => {
  const box = await gh(
    [
      { code: 1, stderr: "not logged in to github.com. use 'gh auth login' to authenticate" },
      { code: 0, stdout: "https://github.com/acme/app/pull/7\n" },
    ],
    ["done"],
  );

  const made = await box.api.pr.create();

  assert.deepEqual(made, {
    ok: true,
    url: "https://github.com/acme/app/pull/7",
    existed: false,
    reason: "",
  });
  assert.equal(box.asked.length, 1);
  assert.match(box.asked[0] ?? "", /gh auth login/);
  assert.deepEqual(box.commands, ["gh pr create --fill", "gh pr create --fill"]);
});

test("a gh that is not on PATH names the install, and every method waits the same way", async () => {
  const box = await gh([{ code: 127, stderr: "gh: command not found" }, { code: 0 }], ["done"]);

  const done = await box.api.pr.approve("42");

  assert.deepEqual(done, { ok: true, reason: "" });
  assert.match(box.asked[0] ?? "", /not installed/);
  assert.deepEqual(box.commands, ["gh pr review '42' --approve", "gh pr review '42' --approve"]);
});

test("skip at the readiness gate hands the failure back to the workflow", async () => {
  const box = await gh([{ code: 1, stderr: "no git remotes found" }], ["skip"]);

  const made = await box.api.pr.create();

  assert.deepEqual(made, { ok: false, url: "", existed: false, reason: "no git remotes found" });
  assert.equal(box.commands.length, 1);
});

test("a branch whose pull request is open already answers with the open one", async () => {
  const box = await gh(
    [
      {
        code: 1,
        stderr: 'a pull request for branch "fix" into branch "main" already exists: https://x.test/pull/3',
      },
      { code: 0, stdout: '{"url":"https://github.com/acme/app/pull/3"}' },
    ],
    [],
  );

  const made = await box.api.pr.create({ cwd: "/work" });

  assert.deepEqual(made, {
    ok: true,
    url: "https://github.com/acme/app/pull/3",
    existed: true,
    reason: "",
  });
  assert.deepEqual(box.asked, []);
  assert.deepEqual(box.commands, ["gh pr create --fill", "gh pr view --json url"]);
});

test("a create with a title and a body passes them instead of filling from the commits", async () => {
  const box = await gh([{ code: 0, stdout: "https://github.com/acme/app/pull/9\n" }], []);

  const made = await box.api.pr.create({
    title: "fix: pin the footer",
    body: "the footer scrolls away",
  });

  assert.deepEqual(made, {
    ok: true,
    url: "https://github.com/acme/app/pull/9",
    existed: false,
    reason: "",
  });
  assert.deepEqual(box.commands, ["gh pr create --title 'fix: pin the footer' --body-file -"]);
  assert.deepEqual(box.stdins, ["the footer scrolls away"]);
});

test("a failure no person can fix stays a failure and asks nothing", async () => {
  const box = await gh(
    [{ code: 1, stderr: "could not compute title or body defaults: no commits" }],
    [],
  );

  const made = await box.api.pr.create();

  assert.deepEqual(made, {
    ok: false,
    url: "",
    existed: false,
    reason: "could not compute title or body defaults: no commits",
  });
  assert.deepEqual(box.asked, []);
});

const gitFile = fileURLToPath(new URL("../packages/engine/examples/adapters/git.ts", import.meta.url));

type Git = {
  push(branch: string, options?: { cwd?: string }): Promise<{ ok: boolean; reason: string }>;
  worktree: {
    add(
      name: string,
      options?: { ref?: string },
    ): Promise<{ ok: boolean; path: string; exists: boolean; reason: string }>;
  };
};

type GitBox = { api: Git; commands: string[] };

/** A git whose every call is scripted, under a state root the case owns. */
async function git(t: TestContext, replies: Shelled[]): Promise<GitBox & { state: string }> {
  const state = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "penguin-state-")));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const commands: string[] = [];
  const host: Host = {
    cwd: "/repo/app",
    state,
    catalogs: [],
    shell: async (cmd) => {
      commands.push(cmd);
      const next = replies.shift() ?? { code: 0 };
      return { code: next.code, stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
    },
    exec: async () => 0,
    wait: <T,>(_label: string, body: () => Promise<T>) => body(),
    emit: () => {},
    gate: (() => {
      throw new Error("the git adapter asks no gate");
    }) as Host["gate"],
    credential: (() => {
      throw new Error("the git adapter asks for no credential");
    }) as Host["credential"],
  };
  const definition = await loadAdapter(gitFile);
  return { api: definition.build(host) as Git, commands, state };
}

test("a worktree is cut under the run state root, on a branch of its own name", async (t) => {
  const box = await git(t, [{ code: 0, stdout: "/repo/app\n" }, { code: 0 }]);

  const made = await box.api.worktree.add("stop-the-footer-scrolling");

  const target = path.join(box.state, "worktrees", "app", "stop-the-footer-scrolling");
  assert.deepEqual(made, { ok: true, path: target, exists: false, reason: "" });
  assert.deepEqual(box.commands, [
    "git rev-parse --show-toplevel",
    `git worktree add -b 'stop-the-footer-scrolling' '${target}'`,
  ]);
  assert.ok(fs.existsSync(path.dirname(target)), "the project folder was not made");
});

test("a worktree path that is taken is reported, and git is never called", async (t) => {
  const box = await git(t, [{ code: 0, stdout: "/repo/app\n" }]);
  const target = path.join(box.state, "worktrees", "app", "taken");
  fs.mkdirSync(target, { recursive: true });

  const made = await box.api.worktree.add("taken");

  assert.equal(made.ok, false);
  assert.equal(made.exists, true);
  assert.deepEqual(box.commands, ["git rev-parse --show-toplevel"]);
});

test("a push names the branch and its remote", async (t) => {
  const box = await git(t, [{ code: 0 }]);

  const done = await box.api.push("stop-the-footer-scrolling", { cwd: "/work" });

  assert.deepEqual(done, { ok: true, reason: "" });
  assert.deepEqual(box.commands, ["git push -u origin 'stop-the-footer-scrolling'"]);
});
