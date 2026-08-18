import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act, type ReactNode } from "react";
import { Dashboard } from "../src/tui/dashboard.tsx";
import { Editor } from "../src/tui/editor.ts";
import { controlFor } from "../src/tui/gate.ts";
import { plainAttach } from "../src/tui/plain.ts";
import { type Left, RunView } from "../src/tui/run-view.tsx";
import type { ViewEvent } from "../src/types.ts";

type Box = {
  home: string;
  run(name: string, events: ViewEvent[], options?: { live?: boolean; workflow?: string }): string;
};

function restore(name: string, prior: string | undefined): void {
  if (prior === undefined) delete process.env[name];
  else process.env[name] = prior;
}

function sandbox(t: TestContext): Box {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "penguin-tui-")));
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const runs = path.join(state, "penguin", "runs");
  fs.mkdirSync(runs, { recursive: true });
  const prior = { home: process.env["PENGUIN_HOME"], state: process.env["XDG_STATE_HOME"] };
  process.env["PENGUIN_HOME"] = home;
  process.env["XDG_STATE_HOME"] = state;
  t.after(() => {
    restore("PENGUIN_HOME", prior.home);
    restore("XDG_STATE_HOME", prior.state);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    home,
    run(name, events, options) {
      const dir = path.join(runs, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "run.json"),
        JSON.stringify({
          workflow: options?.workflow ?? `/work/${name}.ts`,
          cwd: "/work",
          params: {},
          createdAt: new Date().toISOString(),
        }),
      );
      fs.writeFileSync(path.join(dir, "inbox.jsonl"), "");
      fs.writeFileSync(
        path.join(dir, "events.jsonl"),
        events.map((event) => `${JSON.stringify(event)}\n`).join(""),
      );
      if (options?.live === true) fs.writeFileSync(path.join(dir, "lock"), String(process.pid));
      return dir;
    },
  };
}

function inbox(dir: string): Record<string, unknown>[] {
  return fs
    .readFileSync(path.join(dir, "inbox.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function screen(node: ReactNode, width = 100, height = 24): Promise<TestRendererSetup> {
  const setup = await testRender(node, { width, height });
  await setup.flush();
  return setup;
}

async function press(setup: TestRendererSetup, keys: string[]): Promise<void> {
  for (const key of keys) {
    await act(async () => {
      setup.mockInput.pressKey(key);
    });
  }
  await setup.flush();
}

async function type(setup: TestRendererSetup, text: string): Promise<void> {
  await act(async () => {
    await setup.mockInput.typeText(text);
  });
  await setup.flush();
}

const nothing = (): void => {};

test("the dashboard lists a live run and a done run with their states", async (t) => {
  const box = sandbox(t);
  box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "state", state: "running", detail: "drafting the plan" },
    ],
    { live: true, workflow: "/work/plan.ts" },
  );
  box.run("ticket-2", [
    { type: "run", phase: "started", run: "ticket-2" },
    { type: "run", phase: "done", run: "ticket-2", result: "merged" },
  ]);
  const setup = await screen(<Dashboard onOpen={nothing} onExit={nothing} />);
  try {
    const frame = await setup.waitForFrame((text) => text.includes("plan-1") && text.includes("ticket-2"));
    assert.match(frame, /plan-1 {2}\/work\/plan\.ts {2}running: drafting the plan/);
    assert.match(frame, /ticket-2 {2}\/work\/ticket-2\.ts {2}done/);
  } finally {
    setup.renderer.destroy();
  }
});

test("needs you names the run, the path, and the question", async (t) => {
  const box = sandbox(t);
  box.run(
    "review-1",
    [
      { type: "run", phase: "started", run: "review-1" },
      { type: "activity", phase: "start", id: "a1", label: "review round 1" },
      { type: "gate", phase: "asked", id: "g-1", question: "Ship these findings?", activity: "a1" },
      { type: "state", state: "blocked", detail: "Ship these findings?" },
    ],
    { live: true },
  );
  const setup = await screen(<Dashboard onOpen={nothing} onExit={nothing} />);
  try {
    const frame = await setup.waitForFrame((text) => text.includes("Ship these findings?"));
    assert.match(frame, /needs you/);
    assert.match(frame, /review-1 {2}review-1 \/ review round 1 {2}Ship these findings\?/);
  } finally {
    setup.renderer.destroy();
  }
});

test("the run tree draws nested activities with their state glyphs", async (t) => {
  const box = sandbox(t);
  box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "activity", phase: "start", id: "a1", label: "plan the work", detail: "ticket: 42" },
      { type: "activity", phase: "start", id: "a2", parent: "a1", label: "write the plan" },
      { type: "activity", phase: "end", id: "a2", outcome: "ok" },
      { type: "session", id: "s1", name: "planner", use: "claude", activity: "a1" },
      { type: "step", phase: "start", id: "st1", label: "agent turn", activity: "a1" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    const frame = await setup.waitForFrame((text) => text.includes("write the plan"));
    assert.match(frame, /plan the work ticket: 42/);
    assert.match(frame, /✓ write the plan/);
    assert.match(frame, /planner/);
  } finally {
    setup.renderer.destroy();
  }
});

test("an enum gate draws a list, and the choice sends one gate-addressed message", async (t) => {
  const box = sandbox(t);
  const dir = box.run(
    "review-1",
    [
      { type: "run", phase: "started", run: "review-1" },
      {
        type: "gate",
        phase: "asked",
        id: "g-1",
        question: "What now?",
        schema: { type: "string", enum: ["approve", "reject"] },
      },
      { type: "state", state: "blocked", detail: "What now?" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="review-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("approve") && text.includes("reject"));
    await press(setup, ["ARROW_DOWN", "RETURN"]);
    assert.deepEqual(inbox(dir), [
      { at: inbox(dir)[0]?.["at"], text: "reject", gate: "g-1" },
    ]);
  } finally {
    setup.renderer.destroy();
  }
});

test("typing a message sends it to the run", async (t) => {
  const box = sandbox(t);
  const dir = box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "state", state: "running", detail: "drafting" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("to run"));
    await type(setup, "wrap it up");
    await press(setup, ["RETURN"]);
    const sent = inbox(dir);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.["text"], "wrap it up");
    assert.equal(sent[0]?.["session"], undefined);
    assert.equal(sent[0]?.["gate"], undefined);
  } finally {
    setup.renderer.destroy();
  }
});

test("a credential goes to the store, and never to the screen or the inbox", async (t) => {
  const box = sandbox(t);
  const dir = box.run(
    "ticket-1",
    [
      { type: "run", phase: "started", run: "ticket-1" },
      {
        type: "credential",
        phase: "asked",
        name: "jira",
        label: "Jira",
        url: "https://id.atlassian.com/manage/api-tokens",
        fields: [
          { name: "site", label: "your Jira site", secret: false },
          { name: "token", label: "the API token", secret: true },
        ],
      },
      { type: "state", state: "blocked", detail: "Jira needs a credential" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="ticket-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("Jira needs a credential"));
    await type(setup, "acme.atlassian.net");
    await press(setup, ["RETURN"]);
    await setup.waitForFrame((text) => text.includes("the API token"));
    await type(setup, "s3cr3t-value");
    const masked = setup.captureCharFrame();
    assert.ok(!masked.includes("s3cr3t-value"), "the secret reached the screen");
    assert.match(masked, /\*{12}/);
    await press(setup, ["RETURN"]);
    const stored = JSON.parse(fs.readFileSync(path.join(box.home, "credentials", "jira.json"), "utf8")) as Record<
      string,
      string
    >;
    assert.deepEqual(stored, { site: "acme.atlassian.net", token: "s3cr3t-value" });
    const sent = inbox(dir);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.["credential"], "jira");
    assert.ok(!JSON.stringify(sent).includes("s3cr3t-value"), "the secret reached the inbox");
    assert.ok(!setup.captureCharFrame().includes("s3cr3t-value"), "the secret stayed on the screen");
  } finally {
    setup.renderer.destroy();
  }
});

test("a done run opens read-only, with no input bar", async (t) => {
  const box = sandbox(t);
  box.run("plan-1", [
    { type: "run", phase: "started", run: "plan-1" },
    { type: "agent", session: "s1", kind: "text", text: "the plan is ready" },
    { type: "run", phase: "done", run: "plan-1", result: "done" },
  ]);
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={false} onLeave={nothing} />);
  try {
    const frame = await setup.waitForFrame((text) => text.includes("this run is done"));
    assert.ok(!frame.includes("to run >"), "a done run offered an input bar");
  } finally {
    setup.renderer.destroy();
  }
});

test("with no terminal a run prints plain lines and the result", async (t) => {
  const box = sandbox(t);
  const dir = box.run("plan-1", [
    { type: "run", phase: "started", run: "plan-1" },
    { type: "activity", phase: "start", id: "a1", label: "plan the work" },
    { type: "agent", session: "s1", kind: "tool", text: "Read", detail: "src/cli.ts" },
    { type: "message", text: "hurry up" },
    { type: "gate", phase: "asked", id: "g-1", question: "Ship it?" },
    { type: "run", phase: "done", run: "plan-1", result: "shipped" },
  ]);
  const written: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await plainAttach("plan-1", dir, "agent claude");
  } finally {
    process.stdout.write = write;
  }
  assert.equal(code, 0);
  assert.deepEqual(written.join("").split("\n").filter((line) => line !== ""), [
    "run plan-1 started, agent claude",
    "plan the work",
    "[Read] src/cli.ts",
    "> hurry up",
    "gate: Ship it?",
    "shipped",
  ]);
});

test("a message to the selected session names it", async (t) => {
  const box = sandbox(t);
  const dir = box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "session", id: "s1", name: "planner", use: "claude" },
      { type: "state", state: "running", detail: "drafting" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("planner"));
    await press(setup, ["ARROW_DOWN"]);
    await setup.waitForFrame((text) => text.includes("to planner"));
    await type(setup, "focus on the tests");
    await press(setup, ["RETURN"]);
    const sent = inbox(dir);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.["session"], "s1");
    assert.equal(sent[0]?.["text"], "focus on the tests");
  } finally {
    setup.renderer.destroy();
  }
});

test("a paste of many lines sends as one message with its newlines", async (t) => {
  const box = sandbox(t);
  const dir = box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "state", state: "blocked", detail: "what next?" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  const pasted = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");
  try {
    await setup.waitForFrame((text) => text.includes("to run"));
    await act(async () => {
      await setup.mockInput.pasteBracketedText(pasted);
    });
    await setup.flush();
    assert.match(setup.captureCharFrame(), /\[pasted #1, 7 lines\]/);
    await press(setup, ["RETURN"]);
    const sent = inbox(dir);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.["text"], pasted);
  } finally {
    setup.renderer.destroy();
  }
});

test("q leaves a run opened from the dashboard back to it", async (t) => {
  const box = sandbox(t);
  box.run("plan-1", [{ type: "run", phase: "started", run: "plan-1" }], { live: true });
  const left: { back: boolean; code: number }[] = [];
  const setup = await screen(
    <RunView
      name="plan-1"
      agent="agent claude"
      ownsExit={false}
      onLeave={(one) => left.push({ back: one.back, code: one.code })}
    />,
  );
  try {
    await setup.waitForFrame((text) => text.includes("to run"));
    await press(setup, ["q"]);
    assert.deepEqual(left, [{ back: true, code: 0 }]);
  } finally {
    setup.renderer.destroy();
  }
});

test("q goes to the dashboard from a directly started run", async (t) => {
  const box = sandbox(t);
  box.run("plan-1", [{ type: "run", phase: "started", run: "plan-1" }], { live: true });
  const left: Left[] = [];
  const setup = await screen(
    <RunView name="plan-1" agent="agent claude" ownsExit={true} onLeave={(one) => left.push(one)} />,
  );
  try {
    await setup.waitForFrame((text) => text.includes("to run"));
    await press(setup, ["q"]);
    assert.deepEqual(left, [{ back: true, code: 0 }]);
  } finally {
    setup.renderer.destroy();
  }
});

test("a directly started run leaves penguin when it ends on screen", async (t) => {
  const box = sandbox(t);
  box.run("plan-1", [
    { type: "run", phase: "started", run: "plan-1" },
    { type: "run", phase: "error", run: "plan-1", reason: "the step blew up" },
  ]);
  const left: Left[] = [];
  const setup = await screen(
    <RunView name="plan-1" agent="agent claude" ownsExit={true} onLeave={(one) => left.push(one)} />,
  );
  try {
    await setup.waitForFrame((text) => text.includes("this run is done"));
    assert.deepEqual(left, [{ back: false, code: 1, note: "run plan-1 failed: the step blew up" }]);
  } finally {
    setup.renderer.destroy();
  }
});

test("Ctrl-C on a run whose process is gone goes to the dashboard", async (t) => {
  const box = sandbox(t);
  const dir = box.run("plan-1", [{ type: "run", phase: "started", run: "plan-1" }], { live: true });
  const left: Left[] = [];
  const setup = await screen(
    <RunView name="plan-1" agent="agent claude" ownsExit={true} onLeave={(one) => left.push(one)} />,
  );
  try {
    await setup.waitForFrame((text) => text.includes("to run"));
    await act(async () => {
      fs.rmSync(path.join(dir, "lock"));
      setup.mockInput.pressCtrlC();
    });
    assert.deepEqual(left, [{ back: true, code: 130 }]);
  } finally {
    setup.renderer.destroy();
  }
});

test("a gate shape picks the control the viewer draws", () => {
  assert.deepEqual(controlFor({ type: "string", enum: ["one", "two"] }), { list: ["one", "two"], many: false });
  assert.deepEqual(controlFor({ type: "array", items: { enum: ["a", "b"] } }), { list: ["a", "b"], many: true });
  assert.deepEqual(controlFor({ type: "boolean" }), { list: ["yes", "no"], many: false });
  assert.deepEqual(controlFor({ type: "string", format: "uri" }), { hint: "url" });
  assert.deepEqual(controlFor({ type: "number" }), { hint: "number" });
});

test("a long paste shows as one token and sends its whole text", () => {
  const editor = new Editor();
  const pasted = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");
  editor.paste(pasted);
  assert.match(editor.shown.text, /^\[pasted #1, 7 lines\]$/);
  assert.equal(editor.take(), pasted);
});
