import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { CallEntry, GateEntry } from "../src/journal.ts";
import { sandbox } from "./helpers.ts";

test("an agent turn returns the validated result and hands the adapter the schema", (t) => {
  const box = sandbox(t);
  box.withShell();
  box.setAgent('{"verdict":"approved","score":7}', "prompts.txt");
  box.write("skill.md", "review the change\n");
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({ ticket: z.string() }),
  async run({ params, agent, shell }) {
    const reviewer = agent();
    const review = await reviewer.run("./skill.md", {
      input: params.ticket,
      result: z.object({ verdict: z.enum(["approved", "changes_needed"]), score: z.number() }),
    });
    await shell.run(\`sh -c 'echo \${review.verdict}:\${review.score} >> out.txt'\`);
  },
});
`,
  );

  const done = box.wa("run", "./w.ts", "--ticket", "ABC-1");

  assert.equal(done.code, 0, done.output);
  assert.deepEqual(box.lines("out.txt"), ["approved:7"]);
  const prompt = box.invocations("prompts.txt")[0] ?? "";
  assert.match(prompt, /review the change/);
  assert.match(prompt, /# Input\n\nABC-1/);
  const turn = box.sessions()[0];
  assert.equal(turn?.first, true);
  const schema = turn?.schema as { properties?: Record<string, unknown> };
  assert.ok(schema.properties?.["verdict"] !== undefined, "the adapter got the JSON schema");
});

test("an agent turn with no result schema records null", (t) => {
  const box = sandbox(t);
  box.setAgent("none", "prompts.txt");
  box.write("skill.md", "implement the plan\n");
  box.write(
    "w.ts",
    `import { workflow } from "wa";
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

  const done = box.wa("run", "./w.ts");

  assert.equal(done.code, 0, done.output);
  assert.equal(box.invocations("prompts.txt").length, 1);
  assert.equal(box.sessions()[0]?.schema, null);
  const entries = box.journal("w-1");
  assert.equal(entries[entries.length - 1]?.type, "done");
});

test("an invalid result is retried once with the error, then gates to a human", (t) => {
  const box = sandbox(t);
  box.withShell();
  box.setAgent("invalid", "prompts.txt");
  box.write("skill.md", "triage the ticket\n");
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ agent, shell }) {
    const triage = await agent().run("./skill.md", { result: z.object({ actionable: z.boolean() }) });
    await shell.run(\`sh -c 'echo \${triage.actionable} >> out.txt'\`);
  },
});
`,
  );

  const parked = box.wa("run", "./w.ts");

  assert.equal(parked.code, 0);
  const prompts = box.invocations("prompts.txt");
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[0] ?? "", /# Correction/);
  assert.match(prompts[1] ?? "", /# Correction/);
  assert.match(prompts[1] ?? "", /actionable/);
  assert.deepEqual(
    box.sessions().map((turn) => turn.first),
    [true, false],
    "the correction went to the same conversation",
  );
  const gate = box.journal("w-1").find((entry): entry is GateEntry => entry.type === "gate");
  assert.equal(gate?.id, "1/gate/0");
  assert.match(gate?.question ?? "", /failed twice/);
  assert.equal(box.exists("out.txt"), false);

  box.setAgent('{"actionable":true}', "prompts.txt");
  const resumed = box.wa("resume", "w-1", "go");

  assert.equal(resumed.code, 0);
  assert.equal(box.invocations("prompts.txt").length, 3);
  assert.deepEqual(box.lines("out.txt"), ["true"]);
});

test("a session use option picks the named agent adapter over the default", (t) => {
  const box = sandbox(t);
  box.setAgent("none", "first.txt", "fake");
  box.setAgent("none", "second.txt", "other");
  box.setDefaults("agent fake");
  box.write("skill.md", "do the thing\n");
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ agent }) {
    await agent().run("./skill.md");
    await agent({ use: "other" }).run("./skill.md");
  },
});
`,
  );

  const done = box.wa("run", "./w.ts");

  assert.equal(done.code, 0, done.output);
  assert.equal(box.invocations("first.txt").length, 1);
  assert.equal(box.invocations("second.txt").length, 1);
});

test("two agent adapters with no default park the run with the fix", (t) => {
  const box = sandbox(t);
  box.setAgent("none", undefined, "fake");
  box.setAgent("none", undefined, "other");
  box.write("skill.md", "do the thing\n");
  box.write(
    "w.ts",
    `import { workflow } from "wa";
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

  const parked = box.wa("run", "./w.ts");

  assert.equal(parked.code, 1);
  assert.match(parked.stdout, /2 agent adapters are installed/);
  assert.match(parked.stdout, /"agent <name>"/);
});

test("a project adapter shadows the home adapter of the same role and name", (t) => {
  const box = sandbox(t);
  box.withShell();
  box.writeAdapter(
    "shell",
    `import { adapter } from "wa";

export default adapter({
  role: "shell",
  name: "shell",
  description: "project shell",
  build: () => ({
    run: () => ({ code: 0, stdout: "local", stderr: "" }),
  }),
});
`,
    "project",
  );
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ shell }) {
    await shell.run("anything");
  },
});
`,
  );

  assert.equal(box.wa("run", "./w.ts").code, 0);

  const call = box
    .journal("w-1")
    .find((entry): entry is CallEntry => entry.type === "call" && entry.kind === "adapter");
  assert.deepEqual(call?.result, { code: 0, stdout: "local", stderr: "" });
});

test("a session cwd resolves from the invoking folder", (t) => {
  const box = sandbox(t);
  box.withShell();
  fs.mkdirSync(path.join(box.project, "sub"));
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ shell }) {
    const where = await shell.run("pwd", { cwd: "sub" });
    await shell.run(\`sh -c 'echo \${where.stdout.trim()} >> out.txt'\`);
  },
});
`,
  );

  assert.equal(box.wa("run", "./w.ts").code, 0);
  assert.deepEqual(box.lines("out.txt"), [fs.realpathSync(path.join(box.project, "sub"))]);
});

test("a skill path resolves against the workflow file, not the run directory", (t) => {
  const box = sandbox(t);
  box.setAgent("none", "prompts.txt");
  box.write("flows/skills/craft.md", "the craft\n");
  box.write(
    "flows/w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ agent }) {
    await agent().run("./skills/craft.md");
  },
});
`,
  );

  const done = box.wa("run", "./flows/w.ts");

  assert.equal(done.code, 0);
  assert.match(box.invocations("prompts.txt")[0] ?? "", /the craft/);
});

test("Promise.all journals completion order and replays by invocation order", (t) => {
  const box = sandbox(t);
  box.withShell();
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ shell, gate }) {
    const [slow, fast] = await Promise.all([
      shell.run("sh -c 'sleep 0.4; echo slow'"),
      shell.run("sh -c 'echo fast'"),
    ]);
    await gate("continue?");
    await shell.run(\`sh -c 'echo \${slow.stdout.trim()}-\${fast.stdout.trim()} >> out.txt'\`);
  },
});
`,
  );

  assert.equal(box.wa("run", "./w.ts").code, 0);
  const calls = box.journal("w-1").filter((entry): entry is CallEntry => entry.type === "call");
  assert.deepEqual(
    calls.map((entry) => entry.id),
    ["1", "0"],
  );

  assert.equal(box.wa("resume", "w-1", "go").code, 0);
  assert.deepEqual(box.lines("out.txt"), ["slow-fast"]);
});

test("a park stops the steps still in flight and journals nothing after it", (t) => {
  const box = sandbox(t);
  box.withShell();
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ shell, gate }) {
    await Promise.all([
      shell.run("sh -c 'sleep 3; echo late >> out.txt'"),
      gate("answer now?"),
    ]);
  },
});
`,
  );

  const started = Date.now();
  const parked = box.wa("run", "./w.ts");

  assert.equal(parked.code, 0);
  assert.ok(Date.now() - started < 3000, "the parked run did not wait for the killed step");
  assert.equal(box.exists("out.txt"), false);
  const entries = box.journal("w-1");
  assert.equal(entries[entries.length - 1]?.type, "gate");

  const resumed = box.wa("resume", "w-1", "go");
  assert.equal(resumed.code, 0);
  assert.deepEqual(box.lines("out.txt"), ["late"]);
});

test("an uncaught error parks the run with the reason", (t) => {
  const box = sandbox(t);
  box.withShell();
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ shell }) {
    await shell.run("sh -c 'echo one >> out.txt'");
    throw new Error("the workflow gave up");
  },
});
`,
  );

  const failed = box.wa("run", "./w.ts");

  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /parked: the workflow gave up/);
  const entries = box.journal("w-1");
  assert.equal(entries[entries.length - 1]?.type, "park");
  assert.deepEqual(box.lines("out.txt"), ["one"]);
});

test("a transcript holds the session conversation across attempts", (t) => {
  const box = sandbox(t);
  box.setAgent("invalid");
  box.write("skill.md", "triage\n");
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ agent }) {
    await agent().run("./skill.md", { result: z.object({ actionable: z.boolean() }) });
  },
});
`,
  );

  box.wa("run", "./w.ts");

  const dir = path.join(box.runDir("w-1"), "transcripts");
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1, "one session, one transcript");
  const text = fs.readFileSync(path.join(dir, files[0] ?? ""), "utf8");
  assert.match(text, /triage[\s\S]*agent ran/);
  assert.match(text, /# Correction/);
});

test("the events file holds the run lifecycle and the activity spans", (t) => {
  const box = sandbox(t);
  box.withShell();
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ shell, view }) {
    await view.activity("round 1", async () => {
      await shell.run("true");
      view.fact({ round: "1/1" });
    });
  },
});
`,
  );

  assert.equal(box.wa("run", "./w.ts").code, 0);

  const events = box.events("w-1");
  const types = events.map((event) => `${event["type"]}${event["phase"] === undefined ? "" : `:${event["phase"]}`}`);
  assert.deepEqual(types, [
    "run:started",
    "activity:start",
    "step:start",
    "step:end",
    "fact",
    "activity:end",
    "run:done",
  ]);
  const span = events[1] as { label?: string; id?: string };
  assert.equal(span.label, "round 1");
  const step = events[2] as { label?: string; activity?: string };
  assert.equal(step.label, "shell.run");
  assert.equal(step.activity, span.id);
});
