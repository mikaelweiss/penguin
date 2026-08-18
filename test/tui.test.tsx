import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act, type ReactNode } from "react";
import { Ask, Pick } from "../src/tui/ask.tsx";
import { Dashboard, type Open } from "../src/tui/dashboard.tsx";
import { Editor } from "../src/tui/editor.ts";
import { controlFor } from "../src/tui/gate.ts";
import { machineLine, strained } from "../src/tui/memory.ts";
import { plainAttach } from "../src/tui/plain.ts";
import { type Left, RunView } from "../src/tui/run-view.tsx";
import type { ViewEvent } from "../src/types.ts";
import { frameWith } from "./drive.tsx";

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

/** Each shim leaves a background child behind, the way xclip does, and holds no stream open. */
const SHIM = '#!/bin/sh\ncat >> "$PENGUIN_TEST_CLIP"\nsleep 3 &\n';

/** Shims for every clipboard tool, so a copy test never touches the real clipboard. */
function clipboard(t: TestContext): { file(): string } {
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "penguin-clip-")));
  const clip = path.join(bin, "clip.txt");
  for (const tool of ["pbcopy", "wl-copy", "xclip"]) {
    fs.writeFileSync(path.join(bin, tool), SHIM, { mode: 0o755 });
  }
  const prior = { path: process.env["PATH"], clip: process.env["PENGUIN_TEST_CLIP"] };
  process.env["PATH"] = `${bin}:${prior.path ?? ""}`;
  process.env["PENGUIN_TEST_CLIP"] = clip;
  t.after(() => {
    restore("PATH", prior.path);
    restore("PENGUIN_TEST_CLIP", prior.clip);
    fs.rmSync(bin, { recursive: true, force: true });
  });
  return {
    file: () => (fs.existsSync(clip) ? fs.readFileSync(clip, "utf8") : ""),
  };
}

/** A PATH with no clipboard tool on it. */
function noTools(t: TestContext): void {
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "penguin-bare-")));
  const prior = process.env["PATH"];
  process.env["PATH"] = bin;
  t.after(() => {
    restore("PATH", prior);
    fs.rmSync(bin, { recursive: true, force: true });
  });
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

/** Every key in one stdin chunk, so no render lands between them. */
async function burst(setup: TestRendererSetup, keys: string[]): Promise<void> {
  await act(async () => {
    for (const key of keys) setup.mockInput.pressKey(key);
  });
  await setup.flush();
}

async function type(setup: TestRendererSetup, text: string): Promise<void> {
  await act(async () => {
    await setup.mockInput.typeText(text);
  });
  await setup.flush();
}

/** Room for a copy that never comes, so a negative assertion means something. */
async function idle(setup: TestRendererSetup): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  await setup.flush();
}

/** The frame a child process writes, which takes longer than a render pass. */
async function shown(setup: TestRendererSetup, want: string): Promise<string> {
  for (let pass = 0; pass < 60; pass += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    await setup.flush();
    const frame = setup.captureCharFrame();
    if (frame.includes(want)) return frame;
  }
  throw new Error(`the frame never held ${want}`);
}

const nothing = (): void => {};

test("the dashboard lists the live runs, and d reveals the done ones", async (t) => {
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
    const first = await frameWith(setup, (text) => text.includes("plan-1"));
    assert.match(first, /plan-1 {2}\/work\/plan\.ts {2}running: drafting the plan/);
    assert.ok(!first.includes("ticket-2"), "a done run listed with the live ones");
    await press(setup, ["d"]);
    const revealed = await frameWith(setup, (text) => text.includes("ticket-2"));
    assert.match(revealed, /^ done *$/m);
    assert.match(revealed, /ticket-2 {2}\/work\/ticket-2\.ts {2}done/);
    await press(setup, ["d"]);
    const hidden = await frameWith(setup, (text) => !text.includes("ticket-2"));
    assert.ok(!hidden.includes("ticket-2"), "d left the done run on the screen");
  } finally {
    setup.renderer.destroy();
  }
});

test("the runs header carries what the machine has left", async (t) => {
  const box = sandbox(t);
  box.run("plan-1", [{ type: "run", phase: "started", run: "plan-1" }], { live: true });
  const setup = await screen(<Dashboard onOpen={nothing} onExit={nothing} />);
  try {
    const frame = await frameWith(setup, (text) => text.includes("ram "));
    const header = frame.split("\n").find((row) => row.includes("ram ")) ?? "";
    assert.match(header, /^ runs {2,}ram \d+\/\d+ GB {2}load \d+\.\d\/\d+ *$/);
  } finally {
    setup.renderer.destroy();
  }
});

test("the readout warns only when another run would oversubscribe the machine", () => {
  const total = 32 * 1024 ** 3;
  assert.equal(strained({ used: total / 2, total, load: 2, cores: 10 }), false);
  assert.equal(strained({ used: total / 2, total, load: 10, cores: 10 }), true);
  assert.equal(strained({ used: total * 0.95, total, load: 1, cores: 10 }), true);
  assert.equal(
    machineLine({ used: 20 * 1024 ** 3, total, load: 8.53, cores: 10 }),
    "ram 20/32 GB  load 8.5/10",
  );
});

test("a run whose process died lists as done", async (t) => {
  const box = sandbox(t);
  box.run("plan-1", [{ type: "run", phase: "started", run: "plan-1" }], { live: true });
  const dead = box.run("ticket-2", [
    { type: "run", phase: "started", run: "ticket-2" },
    { type: "state", state: "running", detail: "still going" },
  ]);
  fs.writeFileSync(path.join(dead, "lock"), "0");
  const setup = await screen(<Dashboard onOpen={nothing} onExit={nothing} />);
  try {
    const first = await frameWith(setup, (text) => text.includes("plan-1"));
    assert.ok(!first.includes("ticket-2"), "a run with a dead lock listed as live");
    await press(setup, ["d"]);
    const revealed = await frameWith(setup, (text) => text.includes("ticket-2"));
    assert.match(revealed, /ticket-2 {2}\/work\/ticket-2\.ts {2}done/);
  } finally {
    setup.renderer.destroy();
  }
});

test("enter on a revealed done run opens it", async (t) => {
  const box = sandbox(t);
  box.run("plan-1", [{ type: "run", phase: "started", run: "plan-1" }], { live: true });
  box.run("ticket-2", [
    { type: "run", phase: "started", run: "ticket-2" },
    { type: "run", phase: "done", run: "ticket-2", result: "merged" },
  ]);
  const opened: Open[] = [];
  const setup = await screen(<Dashboard onOpen={(one) => opened.push(one)} onExit={nothing} />);
  try {
    await frameWith(setup, (text) => text.includes("plan-1"));
    await press(setup, ["d"]);
    await frameWith(setup, (text) => text.includes("ticket-2"));
    await press(setup, ["ARROW_DOWN", "RETURN"]);
    assert.deepEqual(opened, [{ name: "ticket-2" }]);
  } finally {
    setup.renderer.destroy();
  }
});

test("right jumps to the first needs-you line, and a hidden done run does not shift it", async (t) => {
  const box = sandbox(t);
  box.run(
    "review-1",
    [
      { type: "run", phase: "started", run: "review-1" },
      { type: "gate", phase: "asked", id: "g-1", question: "Ship these findings?" },
      { type: "gate", phase: "asked", id: "g-2", question: "Land the branch?" },
      { type: "state", state: "blocked", detail: "Ship these findings?" },
    ],
    { live: true },
  );
  box.run("ticket-2", [
    { type: "run", phase: "started", run: "ticket-2" },
    { type: "run", phase: "done", run: "ticket-2", result: "merged" },
  ]);
  const setup = await screen(<Dashboard onOpen={nothing} onExit={nothing} />);
  try {
    await frameWith(setup, (text) => text.includes("Land the branch?"));
    await press(setup, ["l"]);
    const frame = await frameWith(setup, (text) => / > review-1 {2}review-1 {2}Ship these findings\?/.test(text));
    assert.match(frame, / > review-1 {2}review-1 {2}Ship these findings\?/);
    assert.ok(!/ > review-1 {2}review-1 {2}Land the branch\?/.test(frame), "right skipped the first need");
  } finally {
    setup.renderer.destroy();
  }
});

test("right jumps to the needs-you list with the done section open", async (t) => {
  const box = sandbox(t);
  box.run(
    "review-1",
    [
      { type: "run", phase: "started", run: "review-1" },
      { type: "gate", phase: "asked", id: "g-1", question: "Ship these findings?" },
      { type: "gate", phase: "asked", id: "g-2", question: "Land the branch?" },
      { type: "state", state: "blocked", detail: "Ship these findings?" },
    ],
    { live: true },
  );
  box.run("ticket-2", [
    { type: "run", phase: "started", run: "ticket-2" },
    { type: "run", phase: "done", run: "ticket-2", result: "merged" },
  ]);
  const setup = await screen(<Dashboard onOpen={nothing} onExit={nothing} />);
  try {
    await frameWith(setup, (text) => text.includes("Land the branch?"));
    await press(setup, ["d"]);
    await frameWith(setup, (text) => text.includes("ticket-2"));
    await press(setup, ["l"]);
    const frame = await frameWith(setup, (text) => / > review-1 {2}review-1 {2}Ship these findings\?/.test(text));
    assert.match(frame, / > review-1 {2}review-1 {2}Ship these findings\?/);
    assert.ok(!/ > .*ticket-2 {2}/.test(frame), "right stopped on a done run");
  } finally {
    setup.renderer.destroy();
  }
});

test("d with no live run selects the first done run", async (t) => {
  const box = sandbox(t);
  box.run("ticket-1", [
    { type: "run", phase: "started", run: "ticket-1" },
    { type: "run", phase: "done", run: "ticket-1", result: "merged" },
  ]);
  box.run("ticket-2", [
    { type: "run", phase: "started", run: "ticket-2" },
    { type: "run", phase: "done", run: "ticket-2", result: "merged" },
  ]);
  const setup = await screen(<Dashboard onOpen={nothing} onExit={nothing} />);
  try {
    await frameWith(setup, (text) => text.includes("no live run"));
    await press(setup, ["d"]);
    const revealed = await frameWith(setup, (text) => text.includes("ticket-1"));
    assert.match(revealed, / > .*ticket-1 {2}/);
    assert.ok(!/ > .*ticket-2 {2}/.test(revealed), "d selected the last done run");
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
    const frame = await frameWith(setup, (text) => text.includes("Ship these findings?"));
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
      { type: "session", id: "s1", name: "planner", use: "claude", dir: "/work", activity: "a1" },
      { type: "step", phase: "start", id: "st1", label: "agent turn", activity: "a1" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    const frame = await frameWith(setup, (text) => text.includes("write the plan"));
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
    await frameWith(setup, (text) => text.includes("approve") && text.includes("reject"));
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
    await frameWith(setup, (text) => text.includes("to run"));
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
    await frameWith(setup, (text) => text.includes("Jira needs a credential"));
    await type(setup, "acme.atlassian.net");
    await press(setup, ["RETURN"]);
    await frameWith(setup, (text) => text.includes("the API token"));
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
    const frame = await frameWith(setup, (text) => text.includes("this run is done"));
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
      { type: "session", id: "s1", name: "planner", use: "claude", dir: "/work" },
      { type: "state", state: "running", detail: "drafting" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await frameWith(setup, (text) => text.includes("planner"));
    await press(setup, ["ARROW_DOWN"]);
    await frameWith(setup, (text) => text.includes("to planner"));
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
    await frameWith(setup, (text) => text.includes("to run"));
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
    await frameWith(setup, (text) => text.includes("to run"));
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
    await frameWith(setup, (text) => text.includes("to run"));
    await press(setup, ["q"]);
    assert.deepEqual(left, [{ back: true, code: 0 }]);
  } finally {
    setup.renderer.destroy();
  }
});

test("y copies the one directory of the selected node", async (t) => {
  const box = sandbox(t);
  const clip = clipboard(t);
  box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "session", id: "s1", name: "planner", use: "claude", dir: "/work/wt-a" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("to run"));
    await press(setup, ["y"]);
    await shown(setup, "copied /work/wt-a");
    assert.equal(clip.file().trim(), "/work/wt-a");
  } finally {
    setup.renderer.destroy();
  }
});

test("a param question draws its notes under it, and nothing else", async () => {
  const taken: (string | undefined)[] = [];
  const setup = await screen(
    <Ask
      question="--count <number>"
      options={{ notes: ["--count needs a number", "enter skips"] }}
      onDone={(value) => taken.push(value)}
    />,
  );
  try {
    const frame = await frameWith(setup, (text) => text.includes("--count <number>"));
    const rows = frame.split("\n").map((row) => row.trimEnd()).filter((row) => row !== "");
    assert.deepEqual(rows.slice(0, 3), ["--count <number>", "  --count needs a number", "  enter skips"]);
    await type(setup, "7");
    await press(setup, ["RETURN"]);
    assert.deepEqual(taken, ["7"]);
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
    await frameWith(setup, (text) => text.includes("this run is done"));
    assert.deepEqual(left, [{ back: false, code: 1, note: "run plan-1 failed: the step blew up" }]);
  } finally {
    setup.renderer.destroy();
  }
});

test("y on a node with two directories draws the list, and enter copies the one at the cursor", async (t) => {
  const box = sandbox(t);
  const clip = clipboard(t);
  box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "session", id: "s1", name: "planner", use: "claude", dir: "/work/wt-a" },
      { type: "session", id: "s2", name: "coder", use: "claude", dir: "/work/wt-b" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("to run"));
    await press(setup, ["y"]);
    const frame = await setup.waitForFrame((text) => text.includes("copy which directory?"));
    assert.match(frame, /\/work\/wt-a/);
    assert.match(frame, /\/work\/wt-b/);
    await press(setup, ["ARROW_DOWN", "RETURN"]);
    await shown(setup, "copied /work/wt-b");
    assert.equal(clip.file().trim(), "/work/wt-b");
  } finally {
    setup.renderer.destroy();
  }
});

test("esc closes the copy list and copies nothing", async (t) => {
  const box = sandbox(t);
  const clip = clipboard(t);
  box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "session", id: "s1", name: "planner", use: "claude", dir: "/work/wt-a" },
      { type: "session", id: "s2", name: "coder", use: "claude", dir: "/work/wt-b" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("to run"));
    await press(setup, ["y"]);
    await setup.waitForFrame((text) => text.includes("copy which directory?"));
    await press(setup, ["ESCAPE"]);
    await idle(setup);
    const frame = setup.captureCharFrame();
    assert.ok(!frame.includes("copy which directory?"), "the copy list stayed open");
    assert.equal(clip.file(), "");
  } finally {
    setup.renderer.destroy();
  }
});

test("an escape the terminal folds into the next key copies nothing", async (t) => {
  const box = sandbox(t);
  const clip = clipboard(t);
  box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "session", id: "s1", name: "planner", use: "claude", dir: "/work/wt-a" },
      { type: "session", id: "s2", name: "coder", use: "claude", dir: "/work/wt-b" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("to run"));
    await press(setup, ["y"]);
    await setup.waitForFrame((text) => text.includes("copy which directory?"));
    await burst(setup, ["ESCAPE", "RETURN"]);
    await idle(setup);
    assert.equal(clip.file(), "");
  } finally {
    setup.renderer.destroy();
  }
});

test("a keystroke burst drives the picker with no render between the keys", async (t) => {
  const box = sandbox(t);
  const clip = clipboard(t);
  box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "session", id: "s1", name: "planner", use: "claude", dir: "/work/wt-a" },
      { type: "session", id: "s2", name: "coder", use: "claude", dir: "/work/wt-b" },
      { type: "session", id: "s3", name: "critic", use: "claude", dir: "/work/wt-c" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("to run"));
    await burst(setup, ["y", "ARROW_DOWN", "ARROW_DOWN", "RETURN"]);
    await shown(setup, "copied /work/wt-c");
    assert.equal(clip.file().trim(), "/work/wt-c");
  } finally {
    setup.renderer.destroy();
  }
});

test("y on a run with no session copies the run's own folder", async (t) => {
  const box = sandbox(t);
  const clip = clipboard(t);
  box.run("plan-1", [{ type: "run", phase: "started", run: "plan-1" }], { live: true });
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("to run"));
    await press(setup, ["y"]);
    await shown(setup, "copied /work");
    assert.equal(clip.file().trim(), "/work");
  } finally {
    setup.renderer.destroy();
  }
});

test("a done run still answers y, because the key only reads", async (t) => {
  const box = sandbox(t);
  const clip = clipboard(t);
  box.run("plan-1", [
    { type: "run", phase: "started", run: "plan-1" },
    { type: "session", id: "s1", name: "planner", use: "claude", dir: "/work/wt-a" },
    { type: "run", phase: "done", run: "plan-1", result: "done" },
  ]);
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={false} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("this run is done"));
    await press(setup, ["y"]);
    await shown(setup, "copied /work/wt-a");
    assert.equal(clip.file().trim(), "/work/wt-a");
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
    await frameWith(setup, (text) => text.includes("to run"));
    await act(async () => {
      fs.rmSync(path.join(dir, "lock"));
      setup.mockInput.pressCtrlC();
    });
    assert.deepEqual(left, [{ back: true, code: 130 }]);
  } finally {
    setup.renderer.destroy();
  }
});

test("y with text in the input bar types the letter and copies nothing", async (t) => {
  const box = sandbox(t);
  const clip = clipboard(t);
  box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "session", id: "s1", name: "planner", use: "claude", dir: "/work/wt-a" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("to run"));
    await type(setup, "ab");
    await press(setup, ["y"]);
    await idle(setup);
    assert.match(setup.captureCharFrame(), /to run > aby/);
    assert.equal(clip.file(), "");
  } finally {
    setup.renderer.destroy();
  }
});

test("a param question with choices takes the one the cursor sits on", async () => {
  const taken: (number[] | undefined)[] = [];
  const setup = await screen(
    <Pick
      question="which workflow?"
      choices={[{ label: "count", note: "count things" }, { label: "ticket (global)" }]}
      many={false}
      options={{}}
      onDone={(value) => taken.push(value)}
    />,
  );
  try {
    const frame = await frameWith(setup, (text) => text.includes("which workflow?"));
    assert.match(frame, /\(o\) count {2}count things/);
    assert.match(frame, /\( \) ticket \(global\)/);
    await press(setup, ["ARROW_DOWN", "RETURN"]);
    assert.deepEqual(taken, [[1]]);
  } finally {
    setup.renderer.destroy();
  }
});

test("a missing clipboard tool says so, and the view keeps drawing", async (t) => {
  const box = sandbox(t);
  noTools(t);
  box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "session", id: "s1", name: "planner", use: "claude", dir: "/work/wt-a" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("to run"));
    await press(setup, ["y"]);
    const frame = await shown(setup, "could not copy");
    assert.match(frame, /planner/);
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
