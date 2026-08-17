import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { attach, controlFor } from "../src/viewer.ts";
import { type Sandbox, sandbox, terminal, waitFor } from "./helpers.ts";

const examples = fileURLToPath(new URL("../examples/adapters", import.meta.url));

function gateWorkflow(box: Sandbox, question: string, shape: string): void {
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ gate }) {
    return await gate(${JSON.stringify(question)}, ${shape});
  },
});
`,
  );
}

function inbox(box: Sandbox, run: string): string[] {
  const file = path.join(box.runDir(run), "inbox.jsonl");
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

function shapeOf(shape: z.ZodType): Record<string, unknown> {
  const schema = z.toJSONSchema(shape) as Record<string, unknown>;
  delete schema["$schema"];
  return schema;
}

test("an enum gate draws a single-select list, and the pick answers it", async (t) => {
  const box = sandbox(t);
  gateWorkflow(box, "Environment?", 'z.enum(["dev", "staging", "prod"])');
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

  const screen = terminal(t, box.home);
  const watching = attach("w-1");
  await waitFor(() => screen.text().includes("( ) staging"));
  screen.input.write("\x1b[B");
  await waitFor(() => screen.text().includes("> (o) staging"));
  screen.input.write("\r");
  const ended = await box.waitForEnd("w-1");
  const code = await watching;

  assert.equal(code, 0);
  assert.equal(ended["result"], "staging");
  assert.equal(inbox(box, "w-1").length, 1);
  assert.match(inbox(box, "w-1")[0] ?? "", /"text":"staging"/);
});

test("an array gate draws a checkbox list, and space toggles the labels", async (t) => {
  const box = sandbox(t);
  gateWorkflow(box, "Which targets?", 'z.array(z.enum(["web", "ios"]))');
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

  const screen = terminal(t, box.home);
  const watching = attach("w-1");
  await waitFor(() => screen.text().includes("[ ] web"));
  screen.input.write(" ");
  await waitFor(() => screen.text().includes("[x] web"));
  screen.input.write("\x1b[B");
  await waitFor(() => screen.text().includes("> [ ] ios"));
  screen.input.write(" ");
  await waitFor(() => screen.text().includes("> [x] ios"));
  screen.input.write("\r");
  const ended = await box.waitForEnd("w-1");
  const code = await watching;

  assert.equal(code, 0);
  assert.deepEqual(ended["result"], ["web", "ios"]);
  assert.match(inbox(box, "w-1")[0] ?? "", /"text":"web, ios"/);
});

test("a boolean gate draws yes and no", async (t) => {
  const box = sandbox(t);
  gateWorkflow(box, "Ship it?", "z.boolean()");
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

  const screen = terminal(t, box.home);
  const watching = attach("w-1");
  await waitFor(() => screen.text().includes("( ) no"));
  screen.input.write("\r");
  const ended = await box.waitForEnd("w-1");
  const code = await watching;

  assert.equal(code, 0);
  assert.equal(ended["result"], true);
  assert.match(inbox(box, "w-1")[0] ?? "", /"text":"yes"/);
});

test("a number gate shows the type hint and takes the typed line", async (t) => {
  const box = sandbox(t);
  gateWorkflow(box, "Port?", "z.number().min(1).max(65535)");
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

  const screen = terminal(t, box.home);
  const watching = attach("w-1");
  await waitFor(() => screen.text().includes("expects: number"));
  screen.input.write("8080");
  await waitFor(() => screen.text().includes("> 8080"));
  screen.input.write("\r");
  const ended = await box.waitForEnd("w-1");
  const code = await watching;

  assert.equal(code, 0);
  assert.equal(ended["result"], 8080);
  assert.doesNotMatch(screen.text(), /\(o\)/, "a number gate draws no list");
});

test("an answer from outside cancels the control", async (t) => {
  const box = sandbox(t);
  gateWorkflow(box, "Environment?", 'z.enum(["dev", "staging", "prod"])');
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

  const screen = terminal(t, box.home);
  const watching = attach("w-1");
  await waitFor(() => screen.text().includes("( ) staging"));
  box.send("w-1", "prod");
  const ended = await box.waitForEnd("w-1");
  const code = await watching;

  assert.equal(code, 0);
  assert.equal(ended["result"], "prod");
  assert.equal(inbox(box, "w-1").length, 1, "the viewer sent nothing of its own");
});

test("the control follows the schema", () => {
  assert.deepEqual(controlFor(shapeOf(z.enum(["dev", "prod"]))), {
    list: ["dev", "prod"],
    many: false,
  });
  assert.deepEqual(controlFor(shapeOf(z.array(z.enum(["web", "ios"])))), {
    list: ["web", "ios"],
    many: true,
  });
  assert.deepEqual(controlFor(shapeOf(z.boolean())), { list: ["yes", "no"], many: false });
  assert.deepEqual(controlFor(shapeOf(z.number())), { hint: "number" });
  assert.deepEqual(controlFor(shapeOf(z.url())), { hint: "url" });
  assert.deepEqual(controlFor(shapeOf(z.string())), { hint: "string" });
  assert.deepEqual(controlFor(shapeOf(z.array(z.string()))), { hint: "array" });
});

function talkingAgent(box: Sandbox): void {
  box.writeAdapter(
    "fake",
    `import { adapter } from "penguin";

export default adapter({
  role: "agent",
  name: "fake",
  description: "fake test agent",
  build: (host) => ({
    async turn(turn) {
      const say = (kind, text, detail) =>
        host.emit({ type: "agent", session: turn.session, kind, text, detail });
      say("thinking", "I need the branch");
      say("tool", "Bash", "git status");
      say("tool", "Read");
      say("text", "the branch is clean");
      return { ok: true, value: null };
    },
  }),
});
`,
  );
  box.write("skill.md", "do the thing\n");
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ agent }) {
    await agent().run("./skill.md");
  },
});
`,
  );
}

test("a tool line says what the call acts on, and thinking reads as its own lines", (t) => {
  const box = sandbox(t);
  talkingAgent(box);

  const done = box.penguin("run", "./w.ts");

  assert.equal(done.code, 0, done.output);
  assert.match(done.stdout, /^\[Bash\] git status$/m);
  assert.match(done.stdout, /^\[Read\]$/m);
  assert.match(done.stdout, /^I need the branch$/m);
  assert.match(done.stdout, /^the branch is clean$/m);
});

test("the terminal adapter renders the same call, with thinking set apart", (t) => {
  const box = sandbox(t);
  talkingAgent(box);
  box.writeAdapter("terminal", fs.readFileSync(path.join(examples, "terminal.ts"), "utf8"));

  const done = box.penguin("run", "./w.ts");

  assert.equal(done.code, 0, done.output);
  assert.match(done.stdout, /^\[Bash\] git status$/m);
  assert.match(done.stdout, /^\[Read\]$/m);
  assert.match(done.stdout, /^ {2}I need the branch$/m);
  assert.match(done.stdout, /^the branch is clean$/m);
});
