import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { CallEntry, GateEntry } from "../src/journal.ts";
import { sandbox } from "./helpers.ts";

test("an agent step returns the validated result", (t) => {
  const box = sandbox(t);
  box.setAgent(box.agentCommand('{"verdict":"approved","score":7}', "prompts.txt"));
  box.write("skill.md", "review the change\n");
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  params: z.object({ ticket: z.string() }),
  async run({ params, step }) {
    const review = await step.agent("./skill.md", {
      input: params.ticket,
      result: z.object({ verdict: z.enum(["approved", "changes_needed"]), score: z.number() }),
    });
    await step.command(\`sh -c 'echo \${review.verdict}:\${review.score} >> out.txt'\`);
  },
});
`,
  );

  const done = box.wa("run", "./w.ts", "--ticket", "ABC-1");

  assert.equal(done.code, 0);
  assert.deepEqual(box.lines("out.txt"), ["approved:7"]);
  const prompt = box.invocations("prompts.txt")[0] ?? "";
  assert.match(prompt, /review the change/);
  assert.match(prompt, /# Input\n\nABC-1/);
  assert.match(prompt, /result\.json/);
  assert.match(prompt, /"verdict"/);
});

test("an agent step with no result schema needs no result file", (t) => {
  const box = sandbox(t);
  box.setAgent(box.agentCommand("none", "prompts.txt"));
  box.write("skill.md", "implement the plan\n");
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  params: z.object({}),
  async run({ step }) {
    await step.agent("./skill.md");
  },
});
`,
  );

  const done = box.wa("run", "./w.ts");

  assert.equal(done.code, 0);
  assert.equal(box.invocations("prompts.txt").length, 1);
  assert.doesNotMatch(box.invocations("prompts.txt")[0] ?? "", /result\.json/);
  const entries = box.journal("w-1");
  assert.equal(entries[entries.length - 1]?.type, "done");
});

test("an invalid result is retried once with the error, then gates to a human", (t) => {
  const box = sandbox(t);
  box.setAgent(box.agentCommand("invalid", "prompts.txt"));
  box.write("skill.md", "triage the ticket\n");
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  params: z.object({}),
  async run({ step }) {
    const triage = await step.agent("./skill.md", { result: z.object({ actionable: z.boolean() }) });
    await step.command(\`sh -c 'echo \${triage.actionable} >> out.txt'\`);
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
  const gate = box.journal("w-1").find((entry): entry is GateEntry => entry.type === "gate");
  assert.equal(gate?.id, "0/gate/0");
  assert.match(gate?.question ?? "", /failed twice/);
  assert.equal(box.exists("out.txt"), false);

  box.setAgent(box.agentCommand('{"actionable":true}', "prompts.txt"));
  const resumed = box.wa("resume", "w-1", "go");

  assert.equal(resumed.code, 0);
  assert.equal(box.invocations("prompts.txt").length, 3);
  assert.deepEqual(box.lines("out.txt"), ["true"]);
});

test("a step agent option overrides the default agent", (t) => {
  const box = sandbox(t);
  box.write("skill.md", "do the thing\n");
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  params: z.object({ agent: z.string() }),
  async run({ params, step }) {
    await step.agent("./skill.md", { agent: params.agent });
  },
});
`,
  );

  const done = box.wa("run", "./w.ts", "--agent", box.agentCommand("none", "prompts.txt"));

  assert.equal(fs.existsSync(path.join(box.home, "agent")), false);
  assert.equal(done.code, 0);
  assert.equal(box.invocations("prompts.txt").length, 1);
});

test("cwd resolves from the invoking folder", (t) => {
  const box = sandbox(t);
  fs.mkdirSync(path.join(box.project, "sub"));
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  params: z.object({}),
  async run({ step }) {
    const where = await step.command("pwd", { cwd: "sub" });
    await step.command(\`sh -c 'echo \${where.stdout.trim()} >> out.txt'\`);
  },
});
`,
  );

  assert.equal(box.wa("run", "./w.ts").code, 0);
  assert.deepEqual(box.lines("out.txt"), [fs.realpathSync(path.join(box.project, "sub"))]);
});

test("a skill path resolves against the workflow file, not the run directory", (t) => {
  const box = sandbox(t);
  box.setAgent(box.agentCommand("none", "prompts.txt"));
  box.write("flows/skills/craft.md", "the craft\n");
  box.write(
    "flows/w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  params: z.object({}),
  async run({ step }) {
    await step.agent("./skills/craft.md");
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
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  params: z.object({}),
  async run({ step, gate }) {
    const [slow, fast] = await Promise.all([
      step.command("sh -c 'sleep 0.4; echo slow'"),
      step.command("sh -c 'echo fast'"),
    ]);
    await gate("continue?");
    await step.command(\`sh -c 'echo \${slow.stdout.trim()}-\${fast.stdout.trim()} >> out.txt'\`);
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
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  params: z.object({}),
  async run({ step, gate }) {
    await Promise.all([
      step.command("sh -c 'sleep 3; echo late >> out.txt'"),
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
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  params: z.object({}),
  async run({ step }) {
    await step.command("sh -c 'echo one >> out.txt'");
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

test("a transcript holds every agent invocation", (t) => {
  const box = sandbox(t);
  box.setAgent(box.agentCommand("invalid"));
  box.write("skill.md", "triage\n");
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  params: z.object({}),
  async run({ step }) {
    await step.agent("./skill.md", { result: z.object({ actionable: z.boolean() }) });
  },
});
`,
  );

  box.wa("run", "./w.ts");

  const dir = path.join(box.runDir("w-1"), "transcripts");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["0.0.0.txt", "0.0.1.txt"]);
  assert.match(fs.readFileSync(path.join(dir, "0.0.0.txt"), "utf8"), /triage[\s\S]*agent ran/);
});
