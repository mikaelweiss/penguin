import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { act } from "react";
import { short } from "../src/paths.ts";
import { Dashboard, type Open } from "../src/tui/dashboard.tsx";
import { frameWith, homed, press, screen, typeText } from "./drive.tsx";
import { type Sandbox, sandbox, waitFor } from "./helpers.ts";

const ESC_FLUSH = 60;

const nothing = (): void => {};

/** A lone escape byte reaches the app after the parser gives up on a sequence. */
async function escape(setup: TestRendererSetup): Promise<void> {
  await act(async () => {
    setup.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, ESC_FLUSH));
  });
  await setup.flush();
}

function writes(description: string, params = "z.object({})"): string {
  return `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "${description}",
  params: ${params},
  async run({ params }) {
    return JSON.stringify(params);
  },
});
`;
}

const gates = `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "wait for one answer",
  params: z.object({}),
  async run({ gate }) {
    return await gate("keep going?");
  },
});
`;

/** A workflow in the sandbox home, which the launcher lists as a global entry. */
function workflowIn(box: Sandbox, name: string, source: string): string {
  const file = path.join(box.home, `${name}.ts`);
  fs.writeFileSync(file, source);
  return file;
}

function oldRun(box: Sandbox, name: string): void {
  const dir = box.runDir(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "run.json"),
    JSON.stringify({
      workflow: "/work/old.ts",
      cwd: "/work",
      params: {},
      createdAt: new Date().toISOString(),
    }),
  );
  fs.writeFileSync(path.join(dir, "inbox.jsonl"), "");
  fs.writeFileSync(path.join(dir, "events.jsonl"), "");
}

function runNames(box: Sandbox): string[] {
  if (!fs.existsSync(box.runs)) return [];
  return fs.readdirSync(box.runs).sort();
}

function recordOf(box: Sandbox, name: string): Record<string, unknown> {
  const file = path.join(box.runDir(name), "run.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

test("n lists every workflow with its params and its description", async (t) => {
  const box = sandbox(t);
  workflowIn(
    box,
    "notes",
    writes("take a note and a mode", "z.object({ note: z.string(), mode: z.enum(['fast','slow']) })"),
  );
  homed(t, box);

  const setup = await screen(<Dashboard onOpen={nothing} onExit={nothing} />);
  t.after(() => setup.renderer.destroy());
  await press(setup, ["n"]);
  const frame = await frameWith(setup, (text) => text.includes("take a note and a mode"));

  assert.match(frame, /notes {2}--note <text> --mode <fast\|slow>/);
});

test("esc closes the launcher, and claims no run", async (t) => {
  const box = sandbox(t);
  workflowIn(box, "notes", writes("take a note"));
  oldRun(box, "old-1");
  homed(t, box);
  const opened: Open[] = [];

  const setup = await screen(<Dashboard onOpen={(one) => opened.push(one)} onExit={nothing} />);
  t.after(() => setup.renderer.destroy());
  await frameWith(setup, (text) => text.includes("no live run"));
  await press(setup, ["n"]);
  await frameWith(setup, (text) => text.includes("take a note"));
  await escape(setup);
  const frame = await frameWith(setup, (text) => text.includes("no live run"));

  assert.match(frame, /n starts a workflow/);
  assert.deepEqual(opened, []);
  assert.deepEqual(runNames(box), ["old-1"]);
});

test("invariant 1: the launcher owns the keyboard while it is open", async (t) => {
  const box = sandbox(t);
  oldRun(box, "old-1");
  homed(t, box);
  const opened: Open[] = [];
  let exits = 0;

  const setup = await screen(
    <Dashboard
      onOpen={(one) => opened.push(one)}
      onExit={() => {
        exits += 1;
      }}
    />,
  );
  t.after(() => setup.renderer.destroy());
  await frameWith(setup, (text) => text.includes("no live run"));
  await press(setup, ["n"]);
  await frameWith(setup, (text) => text.includes("no workflow file in"));
  await press(setup, ["q", "RETURN", "ARROW_DOWN", "d"]);
  assert.match(setup.captureCharFrame(), /no workflow file in/);
  await escape(setup);
  const frame = await frameWith(setup, (text) => text.includes("no live run"));

  assert.equal(exits, 0, "q under the launcher left penguin");
  assert.deepEqual(opened, []);
  assert.doesNotMatch(frame, /old-1/, "d under the launcher revealed the done runs");
});

test("a workflow with no param starts on one enter, and its run opens", async (t) => {
  const box = sandbox(t);
  const file = workflowIn(box, "hello", writes("say hello and stop"));
  homed(t, box);
  const opened: Open[] = [];

  const setup = await screen(<Dashboard onOpen={(one) => opened.push(one)} onExit={nothing} />);
  t.after(() => setup.renderer.destroy());
  await press(setup, ["n"]);
  await frameWith(setup, (text) => text.includes("say hello and stop"));
  await press(setup, ["RETURN"]);
  await waitFor(() => opened.length > 0);
  const ended = await box.waitForEnd("hello-1");

  assert.deepEqual(
    opened.map((one) => one.name),
    ["hello-1"],
  );
  assert.equal(recordOf(box, "hello-1")["workflow"], file);
  assert.equal(fs.existsSync(path.join(box.home, "penguin-env.d.ts")), true);
  assert.equal(ended["phase"], "done");
});

test("the view opens on a run the process already holds", async (t) => {
  const box = sandbox(t);
  workflowIn(box, "hold", gates);
  homed(t, box);
  const opened: Open[] = [];

  const setup = await screen(<Dashboard onOpen={(one) => opened.push(one)} onExit={nothing} />);
  t.after(() => setup.renderer.destroy());
  await press(setup, ["n"]);
  await frameWith(setup, (text) => text.includes("wait for one answer"));
  await press(setup, ["RETURN"]);
  await waitFor(() => opened.length > 0);
  const holder = box.holder("hold-1");

  box.send("hold-1", "yes");
  await box.waitForEnd("hold-1");
  assert.notEqual(holder, undefined, "the view opened before the run took the lock");
});

test("the launcher asks each param in order and writes the answers into the run", async (t) => {
  const box = sandbox(t);
  workflowIn(
    box,
    "notes",
    writes("take a note and a mode", "z.object({ note: z.string(), mode: z.enum(['fast','slow']) })"),
  );
  homed(t, box);
  const opened: Open[] = [];

  const setup = await screen(<Dashboard onOpen={(one) => opened.push(one)} onExit={nothing} />);
  t.after(() => setup.renderer.destroy());
  await press(setup, ["n"]);
  await frameWith(setup, (text) => text.includes("take a note and a mode"));
  await press(setup, ["RETURN"]);
  await frameWith(setup, (text) => text.includes("--note <text>"));
  await typeText(setup, "write it down");
  await press(setup, ["RETURN"]);
  const list = await frameWith(setup, (text) => text.includes("--mode <fast|slow>"));
  await press(setup, ["ARROW_DOWN", "RETURN"]);
  await waitFor(() => opened.length > 0);

  assert.match(list, /\(o\) fast/);
  assert.match(list, /\( \) slow/);
  assert.deepEqual(recordOf(box, "notes-1")["params"], { note: "write it down", mode: "slow" });
});

test("an empty answer skips an optional param, and a bad one asks again", async (t) => {
  const box = sandbox(t);
  workflowIn(
    box,
    "count",
    writes("count the things", "z.object({ note: z.string().optional(), total: z.number() })"),
  );
  homed(t, box);
  const opened: Open[] = [];

  const setup = await screen(<Dashboard onOpen={(one) => opened.push(one)} onExit={nothing} />);
  t.after(() => setup.renderer.destroy());
  await press(setup, ["n"]);
  await frameWith(setup, (text) => text.includes("count the things"));
  await press(setup, ["RETURN"]);
  await frameWith(setup, (text) => text.includes("--note <text>"));
  await press(setup, ["RETURN"]);
  await frameWith(setup, (text) => text.includes("--total <number>"));
  await press(setup, ["RETURN"]);
  assert.match(setup.captureCharFrame(), /--total <number>/, "a required param asked again");
  await typeText(setup, "many");
  await press(setup, ["RETURN"]);
  const warned = await frameWith(setup, (text) => text.includes("needs a number"));
  await typeText(setup, "4");
  await press(setup, ["RETURN"]);
  await waitFor(() => opened.length > 0);

  assert.match(warned, /--total needs a number, got many/);
  assert.match(warned, /--total <number>/, "the same question stayed on the screen");
  assert.deepEqual(recordOf(box, "count-1")["params"], { total: 4 });
});

test("an answer the schema refuses names the param and the reason", async (t) => {
  const box = sandbox(t);
  workflowIn(box, "notes", writes("keep a long note", "z.object({ note: z.string().min(5) })"));
  homed(t, box);
  const opened: Open[] = [];

  const setup = await screen(<Dashboard onOpen={(one) => opened.push(one)} onExit={nothing} />);
  t.after(() => setup.renderer.destroy());
  await press(setup, ["n"]);
  await frameWith(setup, (text) => text.includes("keep a long note"));
  await press(setup, ["RETURN"]);
  await frameWith(setup, (text) => text.includes("--note <text>"));
  await typeText(setup, "abc");
  await press(setup, ["RETURN"]);
  const frame = await frameWith(setup, (text) => text.includes("invalid params:"));

  assert.match(frame, /note: Too small/, "the line that names the param shows too");
  assert.deepEqual(opened, []);
  assert.deepEqual(runNames(box), []);
});

test("a params schema that is no object claims no run directory", async (t) => {
  const box = sandbox(t);
  workflowIn(box, "loose", writes("a schema that is not an object", "z.string()"));
  homed(t, box);
  const opened: Open[] = [];

  const setup = await screen(<Dashboard onOpen={(one) => opened.push(one)} onExit={nothing} />);
  t.after(() => setup.renderer.destroy());
  await press(setup, ["n"]);
  await frameWith(setup, (text) => text.includes("loose"));
  await press(setup, ["RETURN"]);
  const frame = await frameWith(setup, (text) => text.includes("Object.entries"));

  assert.match(frame, /esc closes/, "the list takes the keyboard again");
  assert.deepEqual(opened, []);
  assert.deepEqual(runNames(box), []);
});

test("esc during the questions leaves no run directory", async (t) => {
  const box = sandbox(t);
  workflowIn(box, "notes", writes("take a note", "z.object({ note: z.string() })"));
  homed(t, box);
  const opened: Open[] = [];

  const setup = await screen(<Dashboard onOpen={(one) => opened.push(one)} onExit={nothing} />);
  t.after(() => setup.renderer.destroy());
  await press(setup, ["n"]);
  await frameWith(setup, (text) => text.includes("take a note"));
  await press(setup, ["RETURN"]);
  await frameWith(setup, (text) => text.includes("--note <text>"));
  await escape(setup);
  const frame = await frameWith(setup, (text) => text.includes("no live run"));

  assert.match(frame, /n starts a workflow/);
  assert.deepEqual(opened, []);
  assert.deepEqual(runNames(box), []);
});

test("an empty workflow list names the directories penguin read", async (t) => {
  const box = sandbox(t);
  homed(t, box);
  const opened: Open[] = [];

  const setup = await screen(<Dashboard onOpen={(one) => opened.push(one)} onExit={nothing} />, 240);
  t.after(() => setup.renderer.destroy());
  await press(setup, ["n"]);
  const frame = await frameWith(setup, (text) => text.includes("no workflow file in"));
  await press(setup, ["RETURN"]);

  assert.ok(frame.includes(short(path.join(process.cwd(), ".penguin"))), "the project directory shows");
  assert.ok(frame.includes(short(box.home)), "the home directory shows");
  assert.deepEqual(opened, []);
  assert.deepEqual(runNames(box), []);
});
