import { type AdapterFound as Found } from "@mikaelweiss/penguin-engine/catalog";
import type { ViewEvent } from "@mikaelweiss/penguin-engine/protocol";
import { controlFor } from "@mikaelweiss/penguin-viewer";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { act, type ReactNode } from "react";
import { computerLine, strained } from "../apps/cli/src/this-computer/memory.ts";
import { Ask, Pick } from "../apps/cli/src/tui/ask.tsx";
import { Dashboard, type Open } from "../apps/cli/src/tui/dashboard.tsx";
import { Editor } from "../apps/cli/src/tui/editor.ts";
import { Choices } from "../apps/cli/src/tui/input.tsx";
import { type Left, PANE, RunView } from "../apps/cli/src/tui/run-view/run-view.tsx";
import { watchAsLines } from "../apps/cli/src/watch-run/plain.ts";
import { agentLabel, agentLine } from "../apps/cli/src/watch-run/watch.ts";
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

/** An esc byte reaches the parser only after its sequence window closes, so real time passes here. */
async function settle(setup: TestRendererSetup): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await setup.flush();
}

async function escape(setup: TestRendererSetup): Promise<void> {
  await press(setup, ["ESCAPE"]);
  await settle(setup);
}

async function chord(
  setup: TestRendererSetup,
  key: string,
  modifiers: { ctrl?: boolean; meta?: boolean },
): Promise<void> {
  await act(async () => {
    setup.mockInput.pressKey(key, modifiers);
  });
  await settle(setup);
}

/** The tree pane after esc moved focus onto it. */
async function toTree(setup: TestRendererSetup): Promise<void> {
  await escape(setup);
  await frameWith(setup, (text) => text.includes("arrows move, left and right fold"));
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

/** A later event on disk, and the frame the viewer draws once it reads it. */
async function arrive(
  setup: TestRendererSetup,
  dir: string,
  events: ViewEvent[],
  until: (frame: string) => boolean,
): Promise<void> {
  fs.appendFileSync(
    path.join(dir, "events.jsonl"),
    events.map((event) => `${JSON.stringify(event)}\n`).join(""),
  );
  await frameWith(setup, until);
}

function optionGate(schema: Record<string, unknown>): ViewEvent[] {
  return [
    { type: "run", phase: "started", run: "review-1" },
    { type: "gate", phase: "asked", id: "g-1", question: "What now?", schema },
    { type: "state", state: "blocked", detail: "What now?" },
  ];
}

const ONE_OF = { type: "string", enum: ["approve", "reject"] };
const OPEN_OF = { anyOf: [{ type: "string", enum: ["approve", "revise"] }, { type: "string" }] };

/** The screen without its last row, so a test reads the two panes without the status line. */
function panes(frame: string): string {
  return frame.split("\n").slice(0, 23).join("\n");
}

/** Where a line starts on the screen, so a test can place a control against the transcript. */
function column(frame: string, pattern: RegExp, which: "first" | "last" = "first"): number {
  const rows = frame.split("\n").filter((line) => pattern.test(line));
  const row = which === "first" ? rows[0] : rows.at(-1);
  assert.ok(row !== undefined, `no row matched ${pattern}`);
  return row.search(pattern);
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
    computerLine({ used: 20 * 1024 ** 3, total, load: 8.53, cores: 10 }),
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

test("enter on the focused tree opens and closes the selected node", async (t) => {
  const box = sandbox(t);
  const dir = box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "activity", phase: "start", id: "a1", label: "plan the work" },
      { type: "state", state: "running", detail: "drafting" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("plan the work"));
    await toTree(setup);
    await press(setup, ["RETURN"]);
    assert.ok(!setup.captureCharFrame().includes("plan the work"), "enter left the node open");
    await press(setup, ["RETURN"]);
    assert.match(setup.captureCharFrame(), /plan the work/);
    assert.deepEqual(inbox(dir), [], "enter sent an empty message");
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
    const frame = await frameWith(setup, (text) => text.includes("approve") && text.includes("reject"));
    const edge = column(frame, /── gate/);
    assert.ok(edge > PANE, "the transcript starts right of the tree pane");
    assert.equal(
      column(panes(frame), /What now[?]/, "last"),
      edge,
      "the choice list starts at the transcript's left edge",
    );
    assert.ok(column(frame, /[(][ o][)] approve/) > edge, "the choices draw inside the output column");
    await press(setup, ["ARROW_DOWN", "RETURN"]);
    assert.deepEqual(inbox(dir), [
      { at: inbox(dir)[0]?.["at"], text: "reject", gate: "g-1" },
    ]);
  } finally {
    setup.renderer.destroy();
  }
});

test("a gate with options draws one control whose last row types an answer", async (t) => {
  const box = sandbox(t);
  box.run("review-1", optionGate(ONE_OF), { live: true });
  const setup = await screen(<RunView name="review-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    const frame = await setup.waitForFrame((text) => text.includes("type a different answer"));
    const rows = frame.trimEnd().split("\n");
    const approve = rows.findIndex((row) => row.includes("approve"));
    const reject = rows.findIndex((row) => row.includes("reject"));
    const typing = rows.findIndex((row) => row.includes("type a different answer"));
    assert.equal(reject, approve + 1, "the options sit in order");
    assert.equal(typing, reject + 1, "the typing row is the last row of the control");
    assert.match(rows[typing + 1] ?? "", /the last row types an answer/);
  } finally {
    setup.renderer.destroy();
  }
});

test("a gate that names options beside a string draws the options and the typing row", async (t) => {
  const box = sandbox(t);
  const dir = box.run("review-1", optionGate(OPEN_OF), { live: true });
  const setup = await screen(<RunView name="review-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    const frame = await setup.waitForFrame((text) => text.includes("type a different answer"));
    const rows = frame.trimEnd().split("\n");
    const approve = rows.findIndex((row) => row.includes("approve"));
    const revise = rows.findIndex((row) => row.includes("revise"));
    const typing = rows.findIndex((row) => row.includes("type a different answer"));
    assert.equal(revise, approve + 1, "the options sit in order");
    assert.equal(typing, revise + 1, "the typing row is the last row of the control");
    await press(setup, ["RETURN"]);
    assert.deepEqual(inbox(dir), [
      { at: inbox(dir)[0]?.["at"], text: "approve", gate: "g-1" },
    ]);
  } finally {
    setup.renderer.destroy();
  }
});

test("typing at a gate with options sends the text as the answer", async (t) => {
  const box = sandbox(t);
  const dir = box.run("review-1", optionGate(ONE_OF), { live: true });
  const setup = await screen(<RunView name="review-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("approve"));
    await type(setup, "ask me again");
    assert.match(setup.captureCharFrame(), /> +ask me again/, "the text landed on the typing row");
    await press(setup, ["RETURN"]);
    const sent = inbox(dir);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.["text"], "ask me again");
    assert.equal(sent[0]?.["gate"], "g-1");
  } finally {
    setup.renderer.destroy();
  }
});

test("a key that types nothing leaves the cursor on its option", async (t) => {
  const box = sandbox(t);
  const dir = box.run("review-1", optionGate(ONE_OF), { live: true });
  const setup = await screen(<RunView name="review-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("approve"));
    await press(setup, ["ARROW_DOWN", "BACKSPACE", "END", "RETURN"]);
    assert.deepEqual(inbox(dir), [
      { at: inbox(dir)[0]?.["at"], text: "reject", gate: "g-1" },
    ]);
  } finally {
    setup.renderer.destroy();
  }
});

test("the typing row moves by words, the way the input bar does", async (t) => {
  const box = sandbox(t);
  const dir = box.run("review-1", optionGate(ONE_OF), { live: true });
  const setup = await screen(<RunView name="review-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("approve"));
    await type(setup, "two words");
    await act(async () => {
      setup.mockInput.pressKey("ARROW_LEFT", { ctrl: true });
    });
    await setup.flush();
    await type(setup, "many ");
    await press(setup, ["RETURN"]);
    assert.equal(inbox(dir)[0]?.["text"], "two many words");
  } finally {
    setup.renderer.destroy();
  }
});

test("enter on an empty typing row sends nothing and keeps the control", async (t) => {
  const box = sandbox(t);
  const dir = box.run("review-1", optionGate(ONE_OF), { live: true });
  const setup = await screen(<RunView name="review-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("approve"));
    await press(setup, ["ARROW_DOWN", "ARROW_DOWN", "RETURN"]);
    assert.deepEqual(inbox(dir), []);
    assert.match(setup.captureCharFrame(), /approve/, "the control left the screen");
  } finally {
    setup.renderer.destroy();
  }
});

test("a multi-select gate sends every checked option as one message", async (t) => {
  const box = sandbox(t);
  const dir = box.run("review-1", optionGate({ type: "array", items: { enum: ["docs", "tests", "bench"] } }), {
    live: true,
  });
  const setup = await screen(<RunView name="review-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("docs"));
    await press(setup, [" ", "ARROW_DOWN", " ", "RETURN"]);
    assert.deepEqual(inbox(dir), [
      { at: inbox(dir)[0]?.["at"], text: "docs, tests", gate: "g-1" },
    ]);
  } finally {
    setup.renderer.destroy();
  }
});

test("a typed answer ignores the toggles of a multi-select gate", async (t) => {
  const box = sandbox(t);
  const dir = box.run("review-1", optionGate({ type: "array", items: { enum: ["docs", "tests"] } }), { live: true });
  const setup = await screen(<RunView name="review-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("docs"));
    await press(setup, [" "]);
    assert.match(setup.captureCharFrame(), /\[x\] docs/, "space toggled the option under the cursor");
    await type(setup, "neither one");
    await press(setup, ["RETURN"]);
    const sent = inbox(dir);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.["text"], "neither one");
    assert.equal(sent[0]?.["gate"], "g-1");
  } finally {
    setup.renderer.destroy();
  }
});

test("a re-ask with other options resets the cursor and the toggles", async (t) => {
  const box = sandbox(t);
  const dir = box.run("review-1", optionGate({ type: "array", items: { enum: ["docs", "tests"] } }), { live: true });
  const setup = await screen(<RunView name="review-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("docs"));
    await press(setup, ["ARROW_DOWN", " "]);
    assert.match(setup.captureCharFrame(), /\[x\] tests/);
    await arrive(setup, dir, [
      {
        type: "gate",
        phase: "asked",
        id: "g-1",
        question: "What now?",
        schema: { type: "array", items: { enum: ["ship", "hold"] } },
      },
    ], (frame) => frame.includes("ship"));
    const frame = setup.captureCharFrame();
    assert.match(frame, /> \[ \] ship/, "the cursor went back to the first option");
    assert.ok(!frame.includes("[x]"), "a toggle outlived the options it belonged to");
  } finally {
    setup.renderer.destroy();
  }
});

test("an answer from elsewhere closes the control and keeps the typed text", async (t) => {
  const box = sandbox(t);
  const dir = box.run("review-1", optionGate(ONE_OF), { live: true });
  const setup = await screen(<RunView name="review-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("approve"));
    await type(setup, "half a thought");
    await arrive(setup, dir, [
      { type: "gate", phase: "answered", id: "g-1", question: "What now?", answer: "approve" },
    ], (frame) => frame.includes("to run >"));
    const frame = setup.captureCharFrame();
    assert.ok(!frame.includes("type a different answer"), "the control stayed after the answer");
    assert.match(frame, /to run > half a thought/, "the text moved to the next target");
    assert.deepEqual(inbox(dir), [], "closing the control sent an answer");
  } finally {
    setup.renderer.destroy();
  }
});

test("a paste at a gate with options lands on the typing row", async (t) => {
  const box = sandbox(t);
  const dir = box.run("review-1", optionGate(ONE_OF), { live: true });
  const setup = await screen(<RunView name="review-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("approve"));
    await act(async () => {
      await setup.mockInput.pasteBracketedText("a third way");
    });
    await setup.flush();
    assert.match(setup.captureCharFrame(), /> +a third way/);
    await press(setup, ["RETURN"]);
    assert.equal(inbox(dir)[0]?.["text"], "a third way");
  } finally {
    setup.renderer.destroy();
  }
});

test("a failed image paste at a gate with options names the reason", async (t) => {
  const box = sandbox(t);
  noTools(t);
  box.run("review-1", optionGate(ONE_OF), { live: true });
  const setup = await screen(<RunView name="review-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("approve"));
    await act(async () => {
      setup.mockInput.pressKey("v", { ctrl: true });
    });
    await setup.flush();
    const frame = await shown(setup, "no image in the clipboard");
    assert.match(frame, /approve/, "the options left the screen");
  } finally {
    setup.renderer.destroy();
  }
});

test("a cursor past the last option draws as the typing row", async () => {
  const editor = new Editor();
  editor.insert("mine");
  const setup = await screen(
    <Choices
      title="What now?"
      choices={[{ label: "approve" }, { label: "reject" }]}
      cursor={9}
      chosen={[]}
      many={false}
      editor={editor}
      width={40}
    />,
  );
  try {
    const frame = setup.captureCharFrame();
    const rows = frame.split("\n").map((row) => row.trimEnd());
    assert.ok(!rows.some((row) => row.startsWith("> (")), "an option row took the cursor");
    assert.match(frame, /> +mine/);
  } finally {
    setup.renderer.destroy();
  }
});

test("a tall transcript gives up its rows, and the control keeps every one of its own", async (t) => {
  const box = sandbox(t);
  const scrolled: ViewEvent[] = Array.from({ length: 60 }, (_, index) => ({
    type: "agent",
    session: "s1",
    kind: "tool",
    text: "Read",
    detail: `src/file-${index}.ts`,
  }));
  box.run(
    "review-1",
    [
      { type: "run", phase: "started", run: "review-1" },
      ...scrolled,
      {
        type: "gate",
        phase: "asked",
        id: "g-1",
        question: "What now?",
        schema: { type: "string", enum: Array.from({ length: 12 }, (_, index) => `choice-${index}`) },
      },
      { type: "state", state: "blocked", detail: "What now?" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="review-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    const frame = await frameWith(setup, (text) => text.includes("choice-11"));
    const rows = frame.split("\n");
    assert.equal((rows[23] ?? "").trimEnd(), "blocked: What now?", "the status alone draws on the last row");
    assert.match(rows[22] ?? "", /arrows move, enter answers/, "the list keeps its last row above the status");
    assert.match(rows[21] ?? "", /type a different answer/, "the list keeps its typing row above the hint");
    assert.match(rows[20] ?? "", /[(] [)] choice-11/, "the list keeps its last choice");
    const first = rows.findIndex((row) => /[(][ o][)] choice-0/.test(row));
    assert.match(rows[first - 1] ?? "", /What now[?]/, "the list keeps its title");
    assert.equal(rows.filter((row) => /[(][ o][)] choice-/.test(row)).length, 12, "the list keeps all 12 choices");
    assert.ok(
      rows.slice(0, first - 1).some((row) => /\[Read\] src\/file-\d+\.ts/.test(row)),
      "the transcript keeps drawing above the list",
    );
    assert.ok(!frame.includes("src/file-0."), "the transcript scrolled instead of pushing the list off the screen");
  } finally {
    setup.renderer.destroy();
  }
});

test("a control taller than its column stops at the column, never on the status line", async (t) => {
  const box = sandbox(t);
  box.run(
    "ticket-1",
    [
      { type: "run", phase: "started", run: "ticket-1" },
      {
        type: "credential",
        phase: "asked",
        name: "jira",
        label: "Jira",
        fields: Array.from({ length: 22 }, (_, index) => ({
          name: `f${index}`,
          label: `field number ${index}`,
          secret: false,
        })),
      },
      { type: "state", state: "blocked", detail: "Jira needs a credential" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="ticket-1" agent="agent claude" ownsExit={true} onLeave={nothing} />);
  try {
    await frameWith(setup, (text) => text.includes("field number 0"));
    for (let index = 0; index < 19; index++) {
      await type(setup, `value-${index}`);
      await press(setup, ["RETURN"]);
    }
    const rows = setup.captureCharFrame().split("\n");
    assert.match(rows[21] ?? "", /field number 18: value-18/, "the form draws its rows down the column");
    assert.match(rows[22] ?? "", /field number 19/, "the form fills the column to its last row");
    assert.equal(
      (rows[23] ?? "").trimEnd(),
      "blocked: Jira needs a credential",
      "the status alone holds the last row",
    );
  } finally {
    setup.renderer.destroy();
  }
});

test("a screen too short for both panes still keeps the status line to itself", async (t) => {
  const box = sandbox(t);
  const scrolled: ViewEvent[] = Array.from({ length: 45 }, (_, index) => ({
    type: "agent",
    session: "s1",
    kind: "tool",
    text: "Read",
    detail: `src/file-${index}.ts`,
  }));
  box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      ...scrolled,
      { type: "state", state: "running", detail: "drafting" },
    ],
    { live: true },
  );
  for (const height of [2, 3, 4]) {
    const setup = await screen(
      <RunView name="plan-1" agent="agent claude" ownsExit={false} onLeave={nothing} />,
      100,
      height,
    );
    try {
      await setup.flush();
      const rows = setup.captureCharFrame().split("\n");
      assert.equal((rows[height - 1] ?? "").trimEnd(), "running: drafting", `${height} rows: the status stands alone`);
      for (const row of rows) {
        assert.ok(
          !(/\[Read\] src\/file/.test(row) && /to run >/.test(row)),
          `${height} rows: the transcript and the input bar took the same row`,
        );
      }
    } finally {
      setup.renderer.destroy();
    }
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
    const asking = await frameWith(setup, (text) => text.includes("your Jira site"));
    const edge = column(asking, /Jira needs a credential/);
    assert.ok(edge > PANE, "the transcript starts right of the tree pane");
    assert.equal(
      column(panes(asking), /Jira needs a credential/, "last"),
      edge,
      "the credential form starts at the transcript's left edge",
    );
    assert.ok(column(asking, /your Jira site/) > edge, "the form fields draw inside the output column");
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
    const edge = column(frame, /run plan-1 done/);
    assert.ok(edge > PANE, "the transcript starts right of the tree pane");
    assert.equal(column(frame, /this run is done/), edge, "the read-only line starts at the transcript's left edge");
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
    { type: "gate", phase: "asked", id: "g-2", question: "What now?", schema: OPEN_OF },
    { type: "gate", phase: "asked", id: "g-3", question: "Which port?", schema: { type: "number" } },
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
    code = await watchAsLines("plan-1", dir, "agent claude");
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
    "gate: What now?",
    "  options: approve, revise",
    "gate: Which port?",
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
    await toTree(setup);
    await press(setup, ["ARROW_DOWN"]);
    await escape(setup);
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
    await toTree(setup);
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
    await toTree(setup);
    await press(setup, ["q"]);
    assert.deepEqual(left, [{ back: true, code: 0 }]);
  } finally {
    setup.renderer.destroy();
  }
});

test("q types into the input instead of leaving the run", async (t) => {
  const box = sandbox(t);
  box.run("plan-1", [{ type: "run", phase: "started", run: "plan-1" }], { live: true });
  const left: Left[] = [];
  const setup = await screen(
    <RunView name="plan-1" agent="agent claude" ownsExit={false} onLeave={(one) => left.push(one)} />,
  );
  try {
    await frameWith(setup, (text) => text.includes("to run"));
    await type(setup, "q hello");
    const frame = await frameWith(setup, (text) => text.includes("q hello"));
    assert.match(frame, /to run > q hello/);
    assert.deepEqual(left, []);
  } finally {
    setup.renderer.destroy();
  }
});

test("esc parks the draft on the tree, and esc brings it back to finish", async (t) => {
  const box = sandbox(t);
  const dir = box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "state", state: "blocked", detail: "what next?" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={false} onLeave={nothing} />);
  try {
    await frameWith(setup, (text) => text.includes("to run"));
    await type(setup, "hold the");
    await escape(setup);
    const parked = await frameWith(setup, (text) => text.includes("arrows move, left and right fold"));
    assert.match(parked, /to run > hold the/, "the draft waits in the bar");
    assert.ok(column(parked, /arrows move, left and right fold/) < PANE, "the key list draws inside the left pane");
    await escape(setup);
    await frameWith(setup, (text) => !text.includes("arrows move, left and right fold"));
    await type(setup, " line");
    await press(setup, ["RETURN"]);
    const sent = inbox(dir);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.["text"], "hold the line");
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
    await frameWith(setup, (text) => text.includes("to run"));
    await toTree(setup);
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

test("the tree moves the transcript while it holds focus", async (t) => {
  const box = sandbox(t);
  box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "session", id: "s1", name: "planner", use: "claude", dir: "/work/wt-a" },
      { type: "session", id: "s2", name: "critic", use: "claude", dir: "/work/wt-b" },
      { type: "agent", session: "s1", kind: "tool", text: "Read", detail: "planner-file.ts" },
      { type: "agent", session: "s2", kind: "tool", text: "Read", detail: "critic-file.ts" },
      { type: "state", state: "running", detail: "drafting" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={false} onLeave={nothing} />);
  try {
    await frameWith(setup, (text) => text.includes("critic-file.ts"));
    await toTree(setup);
    await press(setup, ["ARROW_DOWN"]);
    const frame = await frameWith(setup, (text) => !text.includes("critic-file.ts"));
    assert.match(frame, /\[Read\] planner-file\.ts/, "the planner transcript draws on the right");
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
    await frameWith(setup, (text) => text.includes("to run"));
    await toTree(setup);
    await press(setup, ["y"]);
    const frame = await frameWith(setup, (text) => text.includes("copy which directory?"));
    assert.match(frame, /\/work\/wt-a/);
    assert.match(frame, /\/work\/wt-b/);
    await press(setup, ["ARROW_DOWN", "RETURN"]);
    await shown(setup, "copied /work/wt-b");
    assert.equal(clip.file().trim(), "/work/wt-b");
  } finally {
    setup.renderer.destroy();
  }
});

test("the tree key list never takes the status row, however short the screen", async (t) => {
  const box = sandbox(t);
  const scrolled: ViewEvent[] = Array.from({ length: 45 }, (_, index) => ({
    type: "agent",
    session: "s1",
    kind: "tool",
    text: "Read",
    detail: `src/file-${index}.ts`,
  }));
  box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      ...scrolled,
      { type: "state", state: "running", detail: "drafting" },
    ],
    { live: true },
  );
  for (const height of [2, 3, 4]) {
    const setup = await screen(
      <RunView name="plan-1" agent="agent claude" ownsExit={false} onLeave={nothing} />,
      100,
      height,
    );
    try {
      await escape(setup);
      const rows = setup.captureCharFrame().split("\n");
      assert.equal((rows[height - 1] ?? "").trimEnd(), "running: drafting", `${height} rows: the status stands alone`);
      for (const row of rows.slice(0, height - 1)) {
        assert.ok(!/running: drafting/.test(row), `${height} rows: the status drew twice`);
      }
    } finally {
      setup.renderer.destroy();
    }
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
    await frameWith(setup, (text) => text.includes("to run"));
    await toTree(setup);
    await press(setup, ["y"]);
    await frameWith(setup, (text) => text.includes("copy which directory?"));
    await press(setup, ["ESCAPE"]);
    await idle(setup);
    const frame = setup.captureCharFrame();
    assert.ok(!frame.includes("copy which directory?"), "the copy list stayed open");
    assert.equal(clip.file(), "");
  } finally {
    setup.renderer.destroy();
  }
});

test("the bar names its keys whole at an ordinary width", async (t) => {
  const box = sandbox(t);
  box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "state", state: "blocked", detail: "what next?" },
    ],
    { live: true },
  );
  for (const [columns, named] of [
    [80, ["enter sends", "esc to the tree", "ctrl-u clears"]],
    [120, ["enter sends", "esc to the tree", "ctrl-u clears", "ctrl-v pastes an image"]],
  ] as [number, string[]][]) {
    const setup = await screen(
      <RunView name="plan-1" agent="agent claude" ownsExit={false} onLeave={nothing} />,
      columns,
    );
    try {
      const frame = await frameWith(setup, (text) => text.includes("to run >"));
      const row = frame.split("\n").find((one) => one.includes("enter sends"));
      assert.ok(row !== undefined, `${columns} columns: the bar named no key`);
      for (const key of named) assert.ok(row.includes(key), `${columns} columns: the bar dropped ${key}`);
      assert.ok(!row.includes("…"), `${columns} columns: the bar cut a key name in half`);
    } finally {
      setup.renderer.destroy();
    }
  }
});

test("the bar keeps the queue note beside its key hints", async (t) => {
  const box = sandbox(t);
  box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "state", state: "running", detail: "drafting" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={false} onLeave={nothing} />, 80);
  try {
    const typing = await frameWith(setup, (text) => text.includes("to run >"));
    assert.match(typing, /the run is busy: this message queues/, "the key hints pushed the queue note off the row");
    await escape(setup);
    const parked = await frameWith(setup, (text) => text.includes("arrows move, left and right fold"));
    assert.match(parked, /the run is busy: this message queues/, "the tree hint pushed the queue note off the row");
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
    await frameWith(setup, (text) => text.includes("to run"));
    await toTree(setup);
    await press(setup, ["y"]);
    await frameWith(setup, (text) => text.includes("copy which directory?"));
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
    await frameWith(setup, (text) => text.includes("to run"));
    await toTree(setup);
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
    await frameWith(setup, (text) => text.includes("to run"));
    await toTree(setup);
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

test("y types the letter while the input holds focus, and copies nothing", async (t) => {
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

test("a chord never reaches the tree keys", async (t) => {
  const box = sandbox(t);
  box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "session", id: "s1", name: "planner", use: "claude", dir: "/work/wt-a" },
      { type: "state", state: "running", detail: "drafting" },
    ],
    { live: true },
  );
  const left: Left[] = [];
  const setup = await screen(
    <RunView name="plan-1" agent="agent claude" ownsExit={false} onLeave={(one) => left.push(one)} />,
  );
  try {
    await frameWith(setup, (text) => text.includes("planner"));
    await toTree(setup);
    await chord(setup, "q", { ctrl: true });
    await chord(setup, "q", { meta: true });
    assert.deepEqual(left, [], "a chord left the run view");
    await press(setup, ["h"]);
    await frameWith(setup, (text) => !text.includes("planner"));
    await chord(setup, "l", { ctrl: true });
    assert.ok(!setup.captureCharFrame().includes("planner"), "ctrl-l unfolded the node");
    await press(setup, ["l"]);
    await frameWith(setup, (text) => text.includes("planner"));
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
    await frameWith(setup, (text) => text.includes("to run"));
    await toTree(setup);
    await press(setup, ["y"]);
    const frame = await shown(setup, "could not copy");
    assert.match(frame, /planner/);
  } finally {
    setup.renderer.destroy();
  }
});

test("y on a dashboard run line copies the run's one directory", async (t) => {
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
  const setup = await screen(<Dashboard onOpen={nothing} onExit={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("plan-1"));
    await press(setup, ["y"]);
    await shown(setup, "copied /work/wt-a");
    assert.equal(clip.file().trim(), "/work/wt-a");
  } finally {
    setup.renderer.destroy();
  }
});

test("y on a dashboard run line with three directories draws the list, and a burst picks the third", async (t) => {
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
  const setup = await screen(<Dashboard onOpen={nothing} onExit={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("plan-1"));
    await burst(setup, ["y", "ARROW_DOWN", "ARROW_DOWN", "RETURN"]);
    await shown(setup, "copied /work/wt-c");
    assert.equal(clip.file().trim(), "/work/wt-c");
  } finally {
    setup.renderer.destroy();
  }
});

test("y on a needs-you line copies that node's directory, not the whole run's", async (t) => {
  const box = sandbox(t);
  const clip = clipboard(t);
  box.run(
    "review-1",
    [
      { type: "run", phase: "started", run: "review-1" },
      { type: "activity", phase: "start", id: "a1", label: "review round 1" },
      { type: "session", id: "s1", name: "critic", use: "claude", dir: "/work/wt-a", activity: "a1" },
      { type: "activity", phase: "start", id: "a2", label: "write the code" },
      { type: "session", id: "s2", name: "coder", use: "claude", dir: "/work/wt-b", activity: "a2" },
      { type: "gate", phase: "asked", id: "g-1", question: "Ship these findings?", activity: "a1" },
      { type: "state", state: "blocked", detail: "Ship these findings?" },
    ],
    { live: true },
  );
  const setup = await screen(<Dashboard onOpen={nothing} onExit={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("Ship these findings?"));
    await press(setup, ["ARROW_DOWN", "y"]);
    await shown(setup, "copied /work/wt-a");
    assert.equal(clip.file().trim(), "/work/wt-a");
  } finally {
    setup.renderer.destroy();
  }
});

test("y on a needs-you line whose node holds two sessions draws the list", async (t) => {
  const box = sandbox(t);
  const clip = clipboard(t);
  box.run(
    "review-1",
    [
      { type: "run", phase: "started", run: "review-1" },
      { type: "activity", phase: "start", id: "a1", label: "review round 1" },
      { type: "session", id: "s1", name: "critic", use: "claude", dir: "/work/wt-a", activity: "a1" },
      { type: "session", id: "s2", name: "second", use: "claude", dir: "/work/wt-b", activity: "a1" },
      { type: "gate", phase: "asked", id: "g-1", question: "Ship these findings?", activity: "a1" },
      { type: "state", state: "blocked", detail: "Ship these findings?" },
    ],
    { live: true },
  );
  const setup = await screen(<Dashboard onOpen={nothing} onExit={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("Ship these findings?"));
    await press(setup, ["ARROW_DOWN", "y"]);
    const frame = await setup.waitForFrame((text) => text.includes("copy which directory?"));
    assert.match(frame, /\/work\/wt-a/);
    assert.match(frame, /\/work\/wt-b/);
    await press(setup, ["RETURN"]);
    await shown(setup, "copied /work/wt-a");
    assert.equal(clip.file().trim(), "/work/wt-a");
  } finally {
    setup.renderer.destroy();
  }
});

test("esc closes the dashboard picker, copies nothing, and the cursor stays put", async (t) => {
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
  box.run("ticket-2", [{ type: "run", phase: "started", run: "ticket-2" }], { live: true });
  let exits = 0;
  const setup = await screen(<Dashboard onOpen={nothing} onExit={() => (exits += 1)} />);
  try {
    await setup.waitForFrame((text) => text.includes("ticket-2"));
    await press(setup, ["y"]);
    await setup.waitForFrame((text) => text.includes("copy which directory?"));
    await press(setup, ["ARROW_DOWN", "q", "ESCAPE"]);
    await idle(setup);
    const frame = setup.captureCharFrame();
    assert.ok(!frame.includes("copy which directory?"), "the copy list stayed open");
    assert.match(frame, /> . plan-1/);
    assert.equal(exits, 0);
    assert.equal(clip.file(), "");
  } finally {
    setup.renderer.destroy();
  }
});

test("ctrl-c exits the dashboard while the picker is open", async (t) => {
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
  let exits = 0;
  const setup = await screen(<Dashboard onOpen={nothing} onExit={() => (exits += 1)} />);
  try {
    await setup.waitForFrame((text) => text.includes("plan-1"));
    await press(setup, ["y"]);
    await setup.waitForFrame((text) => text.includes("copy which directory?"));
    await act(async () => {
      setup.mockInput.pressCtrlC();
    });
    await idle(setup);
    assert.equal(exits, 1);
    assert.equal(clip.file(), "");
  } finally {
    setup.renderer.destroy();
  }
});

test("a done run on the dashboard still copies its recorded directory", async (t) => {
  const box = sandbox(t);
  const clip = clipboard(t);
  box.run("plan-1", [
    { type: "run", phase: "started", run: "plan-1" },
    { type: "session", id: "s1", name: "planner", use: "claude", dir: "/work/wt-a" },
    { type: "run", phase: "done", run: "plan-1", result: "done" },
  ]);
  const setup = await screen(<Dashboard onOpen={nothing} onExit={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("no live run"));
    await press(setup, ["d"]);
    await setup.waitForFrame((text) => text.includes("plan-1"));
    await press(setup, ["y"]);
    await shown(setup, "copied /work/wt-a");
    assert.equal(clip.file().trim(), "/work/wt-a");
  } finally {
    setup.renderer.destroy();
  }
});

test("a done run names only the keys it answers to", async (t) => {
  const box = sandbox(t);
  box.run("plan-1", [
    { type: "run", phase: "started", run: "plan-1" },
    { type: "agent", session: "s1", kind: "text", text: "the plan is ready" },
    { type: "run", phase: "done", run: "plan-1", result: "done" },
  ]);
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={false} onLeave={nothing} />, 120);
  try {
    const frame = await frameWith(setup, (text) => text.includes("this run is done"));
    assert.match(frame, /y copies the directory, q goes to the dashboard/);
    assert.ok(!frame.includes("esc types"), "a done run named esc with no input bar to return to");
  } finally {
    setup.renderer.destroy();
  }
});

test("invariant 19: a session directory that no longer exists still copies as text", async (t) => {
  const box = sandbox(t);
  const clip = clipboard(t);
  const gone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "penguin-gone-")));
  fs.rmSync(gone, { recursive: true, force: true });
  box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "session", id: "s1", name: "planner", use: "claude", dir: gone },
    ],
    { live: true },
  );
  const setup = await screen(<Dashboard onOpen={nothing} onExit={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("plan-1"));
    await press(setup, ["y"]);
    await shown(setup, "copied ");
    assert.equal(clip.file().trim(), gone);
  } finally {
    setup.renderer.destroy();
  }
});

test("y on a run with no session copies the cwd from run.json", async (t) => {
  const box = sandbox(t);
  const clip = clipboard(t);
  box.run("plan-1", [{ type: "run", phase: "started", run: "plan-1" }], { live: true });
  const setup = await screen(<Dashboard onOpen={nothing} onExit={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("plan-1"));
    await press(setup, ["y"]);
    await shown(setup, "copied /work");
    assert.equal(clip.file().trim(), "/work");
  } finally {
    setup.renderer.destroy();
  }
});

test("a dashboard with no line answers y with no copy", async (t) => {
  sandbox(t);
  const clip = clipboard(t);
  const setup = await screen(<Dashboard onOpen={nothing} onExit={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("no live run"));
    await press(setup, ["y"]);
    await idle(setup);
    assert.equal(clip.file(), "");
    assert.match(setup.captureCharFrame(), /y copies the directory/);
  } finally {
    setup.renderer.destroy();
  }
});

test("a missing clipboard tool says so on the dashboard hint line", async (t) => {
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
  const setup = await screen(<Dashboard onOpen={nothing} onExit={nothing} />);
  try {
    await setup.waitForFrame((text) => text.includes("plan-1"));
    await press(setup, ["y"]);
    const frame = await shown(setup, "could not copy");
    assert.ok(!frame.includes("y copies the directory"), "the key hints kept the line");
  } finally {
    setup.renderer.destroy();
  }
});

test("esc on a gate list drops the gate and returns to typing", async (t) => {
  const box = sandbox(t);
  const dir = box.run(
    "review-1",
    [
      { type: "run", phase: "started", run: "review-1" },
      { type: "activity", phase: "start", id: "a1", label: "review round 1" },
      {
        type: "gate",
        phase: "asked",
        id: "g-1",
        question: "Ship it?",
        activity: "a1",
        schema: { type: "string", enum: ["approve", "reject"] },
      },
      { type: "state", state: "blocked", detail: "Ship it?" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="review-1" agent="agent claude" ownsExit={false} onLeave={nothing} />);
  try {
    await frameWith(setup, (text) => text.includes("review round 1"));
    await toTree(setup);
    await press(setup, ["ARROW_DOWN"]);
    await frameWith(setup, (text) => text.includes("(o) approve"));
    await escape(setup);
    await frameWith(setup, (text) => text.includes("to run >"));
    await type(setup, "later");
    await press(setup, ["RETURN"]);
    const sent = inbox(dir);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.["text"], "later");
    assert.equal(sent[0]?.["gate"], undefined);
  } finally {
    setup.renderer.destroy();
  }
});

test("the pane names no tree key while a control owns the keyboard", async (t) => {
  const box = sandbox(t);
  box.run(
    "review-1",
    [
      { type: "run", phase: "started", run: "review-1" },
      { type: "activity", phase: "start", id: "a1", label: "review round 1" },
      {
        type: "gate",
        phase: "asked",
        id: "g-1",
        question: "Ship it?",
        activity: "a1",
        schema: { type: "string", enum: ["approve", "reject"] },
      },
      { type: "state", state: "blocked", detail: "Ship it?" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="review-1" agent="agent claude" ownsExit={false} onLeave={nothing} />);
  try {
    await frameWith(setup, (text) => text.includes("review round 1"));
    await toTree(setup);
    await press(setup, ["ARROW_DOWN"]);
    const asking = await frameWith(setup, (text) => text.includes("(o) approve"));
    assert.ok(!asking.includes("arrows move, left and right fold"), "the pane named the fold keys under a control");
    assert.ok(!asking.includes("q goes to the dashboard"), "the pane named q while the control took every key");
    await escape(setup);
    await frameWith(setup, (text) => text.includes("to run >"));
  } finally {
    setup.renderer.destroy();
  }
});

test("the tree scrolls to keep the selection in the pane", async (t) => {
  const box = sandbox(t);
  const many: ViewEvent[] = Array.from({ length: 30 }, (_, index) => ({
    type: "activity",
    phase: "start",
    id: `a${index}`,
    label: `task ${index}`,
  }));
  box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      ...many,
      { type: "state", state: "running", detail: "drafting" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={false} onLeave={nothing} />);
  try {
    await frameWith(setup, (text) => text.includes("task 0"));
    await toTree(setup);
    for (let step = 0; step < 25; step++) await press(setup, ["ARROW_DOWN"]);
    const frame = await frameWith(setup, (text) => text.includes("task 24"));
    const row = frame.split("\n").find((one) => one.includes("task 24"));
    assert.ok(row?.startsWith(">"), `the selected row lost its marker: ${row}`);
    assert.ok(!frame.includes("task 0 "), "the pane never scrolled past its first rows");
  } finally {
    setup.renderer.destroy();
  }
});

test("ctrl-u empties the draft from anywhere in the line", async (t) => {
  const box = sandbox(t);
  box.run(
    "plan-1",
    [
      { type: "run", phase: "started", run: "plan-1" },
      { type: "state", state: "blocked", detail: "what next?" },
    ],
    { live: true },
  );
  const setup = await screen(<RunView name="plan-1" agent="agent claude" ownsExit={false} onLeave={nothing} />);
  try {
    await frameWith(setup, (text) => text.includes("to run >"));
    await type(setup, "hold the line");
    await press(setup, ["ARROW_LEFT", "ARROW_LEFT", "ARROW_LEFT"]);
    await chord(setup, "u", { ctrl: true });
    const row = setup
      .captureCharFrame()
      .split("\n")
      .find((one) => one.includes("to run >"));
    assert.ok(row?.trimEnd().endsWith("to run >"), `ctrl-u left the draft behind: ${row}`);
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
  assert.deepEqual(controlFor(OPEN_OF), { list: ["approve", "revise"], many: false });
  assert.deepEqual(controlFor({ anyOf: [{ type: "number" }, { type: "string" }] }), { hint: undefined });
});

test("a long paste shows as one token and sends its whole text", () => {
  const editor = new Editor();
  const pasted = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");
  editor.paste(pasted);
  assert.match(editor.shown.text, /^\[pasted #1, 7 lines\]$/);
  assert.equal(editor.take(), pasted);
});

test("every agent header label fits the pane the run view cuts it to", (t) => {
  const box = sandbox(t);
  const one = (name: string): Found => ({
    role: "agent",
    name,
    description: "",
    scope: "global",
    file: `/adapters/${name}.ts`,
    definition: { role: "agent", name, description: "", build: () => ({}) },
  });
  const both = [one("claude"), one("opencode")];
  const room = PANE - " w-1  ".length;

  assert.equal(agentLabel([one("claude")]), "agent claude");
  assert.equal(agentLabel([]), "no agent adapter");
  assert.equal(agentLabel(both), "agent: choose one");

  for (const found of [[], [one("claude")], both]) {
    assert.ok(agentLabel(found).length <= room, agentLabel(found));
  }
  assert.ok(agentLine(both).length > room, "the full line is what the pane cannot hold");

  fs.mkdirSync(box.home, { recursive: true });
  fs.writeFileSync(path.join(box.home, "defaults"), "agent opencode\n");
  const absent = agentLabel([one("claude")]);
  assert.equal(absent, "agent: default missing");
  assert.ok(absent.length <= room, absent);
  assert.ok(agentLine([one("claude")]).length > room, "the full line is what the pane cannot hold");
});
