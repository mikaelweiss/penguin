import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { sandbox, waitFor } from "./helpers.ts";

test("an agent turn returns the validated result and hands the adapter the schema", (t) => {
  const box = sandbox(t);
  box.withShell();
  box.setAgent('{"verdict":"approved","score":7}', "prompts.txt");
  box.write("skill.md", "review the change\n");
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({ ticket: z.string() }),
  async run({ params, agent, shell }) {
    const reviewer = agent();
    const review = (await reviewer.run("./skill.md", {
      input: params.ticket,
      result: z.object({ verdict: z.enum(["approved", "changes_needed"]), score: z.number() }),
    }))!;
    await shell.run(\`sh -c 'echo \${review.verdict}:\${review.score} >> out.txt'\`);
  },
});
`,
  );

  const done = box.penguin("run", "./w.ts", "--ticket", "ABC-1");

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

test("an agent turn with no result schema resolves null", (t) => {
  const box = sandbox(t);
  box.setAgent("none", "prompts.txt");
  box.write("skill.md", "implement the plan\n");
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ agent }) {
    return await agent().run("./skill.md");
  },
});
`,
  );

  const done = box.penguin("run", "./w.ts");

  assert.equal(done.code, 0, done.output);
  assert.equal(box.invocations("prompts.txt").length, 1);
  assert.equal(box.sessions()[0]?.schema, null);
  const ended = box.ended("w-1");
  assert.equal(ended?.["phase"], "done");
  assert.equal(ended?.["result"], null);
});

test("an invalid result is retried once with the correction, then gates", async (t) => {
  const box = sandbox(t);
  box.setAgent("invalid", "prompts.txt");
  box.write("skill.md", "triage the ticket\n");
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
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

  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

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
  assert.match(String(box.lastState("w-1")?.["detail"]), /failed twice/);

  box.send("w-1", "go");
  await waitFor(() => box.invocations("prompts.txt").length === 4);
  await box.waitForState("w-1", "blocked");
  const asked = box.events("w-1").filter((event) => event["phase"] === "asked");
  assert.equal(asked.length, 2, "the reply ran the step again, and it gated again");

  process.kill(box.holder("w-1") as number, "SIGTERM");
  assert.equal((await box.waitForEnd("w-1"))["phase"], "stopped");
});

test("a turn with a blocked schema resolves to the envelope the agent filled", async (t) => {
  const box = sandbox(t);
  const prompts = path.join(box.project, "prompts.txt");
  const schemas = path.join(box.project, "schemas.txt");
  box.writeAdapter(
    "fake",
    `import fs from "node:fs";
import { adapter } from "penguin";

export default adapter({
  role: "agent",
  name: "fake",
  description: "fake test agent",
  build: () => ({
    async turn(turn) {
      fs.appendFileSync(${JSON.stringify(prompts)}, turn.prompt + "\\n---END---\\n");
      fs.appendFileSync(${JSON.stringify(schemas)}, JSON.stringify(turn.schema) + "\\n");
      if (turn.first) return { ok: true, value: { blocked: { questions: ["which database?"] } } };
      return { ok: true, value: { result: { plan: "use sqlite" } } };
    },
  }),
});
`,
  );
  box.write("skill.md", "plan the change\n");
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ agent, gate }) {
    const planner = agent();
    let input = "the ticket";
    for (;;) {
      const out = (await planner.run("./skill.md", {
        input,
        result: z.object({ plan: z.string() }),
        blocked: z.object({ questions: z.array(z.string()) }),
      }))!;
      if (out.blocked !== undefined) {
        input = "answer: " + (await gate(out.blocked.questions[0] ?? ""));
        continue;
      }
      return out.result.plan;
    }
  },
});
`,
  );

  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");
  assert.equal(box.lastState("w-1")?.["detail"], "which database?");

  box.send("w-1", "postgres");
  const ended = await box.waitForEnd("w-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.equal(ended["result"], "use sqlite");
  const asked = box.invocations("prompts.txt");
  assert.equal(asked.length, 2);
  assert.match(asked[1] ?? "", /answer: postgres/);
  const schema = JSON.parse(box.lines("schemas.txt")[0] ?? "null") as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  assert.equal(schema.type, "object", "the schema is one object, never a top-level union");
  assert.deepEqual(
    Object.keys(schema.properties ?? {}).sort(),
    ["blocked", "result"],
    "the adapter got one schema that accepts either envelope",
  );
  assert.equal(schema.required, undefined, "each envelope is optional, and validation picks one");
});

test("a session use option picks the named agent adapter over the default", (t) => {
  const box = sandbox(t);
  box.setAgent("none", "first.txt", "fake");
  box.setAgent("none", "second.txt", "other");
  box.setDefaults("agent fake");
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
    await agent({ use: "other" }).run("./skill.md");
  },
});
`,
  );

  const done = box.penguin("run", "./w.ts");

  assert.equal(done.code, 0, done.output);
  assert.equal(box.invocations("first.txt").length, 1);
  assert.equal(box.invocations("second.txt").length, 1);
});

test("two agent adapters with no default end the run with the fix", (t) => {
  const box = sandbox(t);
  box.setAgent("none", undefined, "fake");
  box.setAgent("none", undefined, "other");
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

  const failed = box.penguin("run", "./w.ts");

  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /2 agent adapters are installed/);
  assert.match(failed.stdout, /"agent <name>"/);
  assert.match(String(box.ended("w-1")?.["reason"]), /2 agent adapters are installed/);
});

test("a project adapter shadows the home adapter of the same role and name", (t) => {
  const box = sandbox(t);
  box.withShell();
  box.writeAdapter(
    "shell",
    `import { adapter } from "penguin";

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
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ shell }) {
    const done = await shell.run("anything");
    return done.stdout;
  },
});
`,
  );

  assert.equal(box.penguin("run", "./w.ts").code, 0);

  assert.equal(box.ended("w-1")?.["result"], "local");
});

test("an adapter method is one step, nested methods included", (t) => {
  const box = sandbox(t);
  box.writeAdapter(
    "git",
    `import { adapter } from "penguin";

export default adapter({
  role: "vcs",
  name: "git",
  description: "test vcs",
  build: () => ({
    worktree: {
      add: (name) => ({ path: "/work/" + name }),
    },
  }),
});
`,
  );
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ vcs }) {
    const ws = await vcs.worktree.add("branch");
    return ws.path;
  },
});
`,
  );

  assert.equal(box.penguin("run", "./w.ts").code, 0);

  const steps = box.events("w-1").filter((event) => event["type"] === "step");
  assert.deepEqual(
    steps.map((event) => [event["phase"], event["label"]]),
    [
      ["start", "vcs.worktree.add"],
      ["end", "vcs.worktree.add"],
    ],
  );
  assert.equal(box.ended("w-1")?.["result"], "/work/branch");
});

test("a session cwd resolves from the invoking folder", (t) => {
  const box = sandbox(t);
  box.withShell();
  fs.mkdirSync(path.join(box.project, "sub"));
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
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

  assert.equal(box.penguin("run", "./w.ts").code, 0);
  assert.deepEqual(box.lines("out.txt"), [fs.realpathSync(path.join(box.project, "sub"))]);
});

test("a skill path resolves against the workflow file, not the run directory", (t) => {
  const box = sandbox(t);
  box.setAgent("none", "prompts.txt");
  box.write("flows/skills/craft.md", "the craft\n");
  box.write(
    "flows/w.ts",
    `import { workflow } from "penguin";
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

  const done = box.penguin("run", "./flows/w.ts");

  assert.equal(done.code, 0);
  assert.match(box.invocations("prompts.txt")[0] ?? "", /the craft/);
});

test("Promise.all runs the steps together", (t) => {
  const box = sandbox(t);
  box.withShell();
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ shell }) {
    const [slow, fast] = await Promise.all([
      shell.run("sh -c 'sleep 0.4; echo slow'"),
      shell.run("sh -c 'echo fast'"),
    ]);
    return \`\${slow.stdout.trim()}-\${fast.stdout.trim()}\`;
  },
});
`,
  );

  assert.equal(box.penguin("run", "./w.ts").code, 0);

  const steps = box.events("w-1").filter((event) => event["type"] === "step");
  assert.deepEqual(
    steps.map((event) => [event["phase"], event["id"]]),
    [
      ["start", "0"],
      ["start", "1"],
      ["end", "1"],
      ["end", "0"],
    ],
    "the fast step ended while the slow one was still running",
  );
  assert.equal(box.ended("w-1")?.["result"], "slow-fast");
});

test("an uncaught error ends the run with the reason", (t) => {
  const box = sandbox(t);
  box.withShell();
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
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

  const failed = box.penguin("run", "./w.ts");

  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /run w-1 failed: the workflow gave up/);
  const ended = box.ended("w-1");
  assert.equal(ended?.["phase"], "error");
  assert.equal(ended?.["reason"], "the workflow gave up");
  assert.deepEqual(box.lines("out.txt"), ["one"]);
});

test("a transcript holds the session conversation across attempts", async (t) => {
  const box = sandbox(t);
  box.setAgent("invalid");
  box.write("skill.md", "triage\n");
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
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

  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

  const dir = path.join(box.runDir("w-1"), "transcripts");
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1, "one session, one transcript");
  const text = fs.readFileSync(path.join(dir, files[0] ?? ""), "utf8");
  assert.match(text, /triage[\s\S]*agent ran/);
  assert.match(text, /# Correction/);

  process.kill(box.holder("w-1") as number, "SIGTERM");
  await box.waitForEnd("w-1");
});

test("the events file holds the run lifecycle and the activity spans", (t) => {
  const box = sandbox(t);
  box.withShell();
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ shell, view }) {
    await view.activity("round 1", async () => {
      await shell.run("true");
      view.fact({ round: "1/1" });
      view.artifact({ title: "the note", path: "note.md" });
    });
  },
});
`,
  );

  assert.equal(box.penguin("run", "./w.ts").code, 0);

  const events = box.events("w-1");
  const types = events.map(
    (event) => `${event["type"]}${event["phase"] === undefined ? "" : `:${event["phase"]}`}`,
  );
  assert.deepEqual(types, [
    "run:started",
    "activity:start",
    "step:start",
    "state",
    "step:end",
    "state",
    "fact",
    "artifact",
    "activity:end",
    "run:done",
  ]);
  const span = events[1] as { label?: string; id?: string };
  assert.equal(span.label, "round 1");
  const step = events[2] as { label?: string; activity?: string };
  assert.equal(step.label, "shell.run");
  assert.equal(step.activity, span.id);
});

test("the running state names the step that is running", (t) => {
  const box = sandbox(t);
  box.withShell();
  box.setAgent("none");
  box.write("skill.md", "do the thing\n");
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ agent, shell }) {
    await shell.run("true");
    await agent().run("./skill.md");
  },
});
`,
  );

  assert.equal(box.penguin("run", "./w.ts").code, 0);

  assert.deepEqual(
    box
      .events("w-1")
      .filter((event) => event["type"] === "state")
      .map((event) => `${String(event["state"])}:${String(event["detail"] ?? "")}`),
    ["running:shell.run", "running:", "running:agent ./skill.md", "running:"],
  );
});

test("a session event names each session, by default and by option", (t) => {
  const box = sandbox(t);
  box.setAgent("none");
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
    await agent().run("./skill.md");
    await agent({ name: "reviewer" }).run("./skill.md");
  },
});
`,
  );

  assert.equal(box.penguin("run", "./w.ts").code, 0);

  const sessions = box.events("w-1").filter((event) => event["type"] === "session");
  assert.deepEqual(
    sessions.map((event) => event["name"]),
    ["fake-1", "fake-2", "reviewer"],
  );
  assert.deepEqual(
    [...new Set(sessions.map((event) => event["use"]))],
    ["fake"],
  );
  assert.deepEqual(
    sessions.map((event) => event["id"]),
    box.sessions().map((turn) => turn.session),
  );
});

test("a gate posts blocked with the question, then running when the answer lands", async (t) => {
  const box = sandbox(t);
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ gate }) {
    return await gate("keep going?");
  },
});
`,
  );

  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");
  assert.equal(box.lastState("w-1")?.["detail"], "keep going?");

  box.send("w-1", "yes");
  const ended = await box.waitForEnd("w-1");

  assert.equal(ended["phase"], "done");
  assert.equal(ended["result"], "yes");
  assert.deepEqual(
    box.events("w-1")
      .filter((event) => event["type"] === "state")
      .map((event) => event["state"]),
    ["blocked", "running"],
  );
});

test("a typed gate parses the answer and carries the schema", async (t) => {
  const box = sandbox(t);
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ gate }) {
    const port = await gate("Port?", z.number().min(1).max(65535));
    const env = await gate("Environment?", z.enum(["dev", "staging", "prod"]));
    const targets = await gate("Which targets?", z.array(z.enum(["web", "ios"])));
    const ship = await gate("Ship it?", z.boolean());
    const notes = await gate("Notes?", z.string());
    const free = await gate("Anything to add?");
    return { port, env, targets, ship, notes, free };
  },
});
`,
  );

  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");
  box.send("w-1", "8080");
  box.send("w-1", "staging");
  box.send("w-1", "web, ios");
  box.send("w-1", "yes");
  box.send("w-1", "one, two");
  box.send("w-1", "a, b");
  const ended = await box.waitForEnd("w-1");

  assert.deepEqual(ended["result"], {
    port: 8080,
    env: "staging",
    targets: ["web", "ios"],
    ship: true,
    notes: "one, two",
    free: "a, b",
  });
  const asked = box.events("w-1").filter((event) => event["phase"] === "asked");
  assert.deepEqual(
    asked.map((event) => event["schema"]),
    [
      { type: "number", minimum: 1, maximum: 65535 },
      { type: "string", enum: ["dev", "staging", "prod"] },
      { type: "array", items: { type: "string", enum: ["web", "ios"] } },
      { type: "boolean" },
      { type: "string" },
      undefined,
    ],
  );
});

test("a typed gate warns and asks the same question again", async (t) => {
  const box = sandbox(t);
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ gate }) {
    return await gate("Repo URL?", z.url());
  },
});
`,
  );

  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");
  box.send("w-1", "not a url");
  await waitFor(
    () => box.events("w-1").filter((event) => event["phase"] === "asked").length === 2,
  );

  assert.equal(box.ended("w-1"), undefined, "the run waits for an answer that fits");
  const warned = box.events("w-1").find((event) => event["level"] === "warn");
  assert.equal(warned?.["message"], 'the answer "not a url" does not fit: Invalid URL');

  box.send("w-1", "https://example.com/x");
  const ended = await box.waitForEnd("w-1");

  assert.equal(ended["result"], "https://example.com/x");
  assert.deepEqual(
    box.events("w-1")
      .filter((event) => event["phase"] === "answered")
      .map((event) => event["answer"]),
    ["https://example.com/x"],
  );
});

test("ctx.messages delivers the text and the session it was addressed to", async (t) => {
  const box = sandbox(t);
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ messages }) {
    const message = await messages.next();
    return \`\${message.session}:\${message.text}\`;
  },
});
`,
  );

  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");
  box.send("w-1", "look at the diff", "worker");
  const ended = await box.waitForEnd("w-1");

  assert.equal(ended["result"], "worker:look at the diff");
  const message = box.events("w-1").find((event) => event["type"] === "message");
  assert.equal(message?.["session"], "worker");
});

test("host.wait shows the run idle with the label", async (t) => {
  const box = sandbox(t);
  box.withClock();
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({ file: z.string() }),
  async run({ params, clock }) {
    await clock.until(params.file);
    return "arrived";
  },
});
`,
  );

  const file = path.join(box.project, "commit.txt");
  assert.equal(box.penguin("run", "./w.ts", "--file", file, "--background").code, 0);
  await box.waitForState("w-1", "idle");
  assert.equal(box.lastState("w-1")?.["detail"], "new commits");

  fs.writeFileSync(file, "");
  const ended = await box.waitForEnd("w-1");

  assert.equal(ended["result"], "arrived");
});

test("a wait pairs a start and an end event, and the plain view prints the label", (t) => {
  const box = sandbox(t);
  box.withClock();
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({ file: z.string() }),
  async run({ params, clock, view }) {
    await view.activity("watching", () => clock.until(params.file));
    return "arrived";
  },
});
`,
  );
  const file = path.join(box.project, "commit.txt");
  fs.writeFileSync(file, "");

  const done = box.penguin("run", "./w.ts", "--file", file);

  assert.equal(done.code, 0, done.output);
  assert.match(done.stdout, /^new commits$/m, "the plain view shows the idle wait");
  const events = box.events("w-1");
  const activity = events.find((event) => event["type"] === "activity");
  const waits = events.filter((event) => event["type"] === "wait");
  assert.deepEqual(
    waits.map((event) => [event["phase"], event["id"]]),
    [
      ["start", "w0"],
      ["end", "w0"],
    ],
    "one wait, one start, one end",
  );
  assert.equal(waits[0]?.["label"], "new commits");
  assert.deepEqual(
    waits.map((event) => event["activity"]),
    [activity?.["id"], activity?.["id"]],
    "both ends carry the activity the wait happened in",
  );
});

test("a session event and an agent event carry the activity the turn ran in", (t) => {
  const box = sandbox(t);
  box.setAgent("none");
  box.write("skill.md", "do the thing\n");
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ agent, view }) {
    await view.activity("round 1", async () => {
      await agent({ name: "worker" }).run("./skill.md");
    });
    await agent({ name: "loner" }).run("./skill.md");
  },
});
`,
  );

  assert.equal(box.penguin("run", "./w.ts").code, 0);

  const events = box.events("w-1");
  const activity = events.find((event) => event["type"] === "activity");
  const sessions = events.filter((event) => event["type"] === "session");
  assert.deepEqual(
    sessions.map((event) => [event["name"], event["activity"]]),
    [
      ["worker", activity?.["id"]],
      ["loner", undefined],
    ],
    "a session outside every activity carries none",
  );
  const inside = sessions[0]?.["id"];
  const said = events.filter((event) => event["type"] === "agent" && event["session"] === inside);
  assert.equal(said.length, 1);
  assert.equal(said[0]?.["activity"], activity?.["id"]);
  assert.equal(said[0]?.["text"], "agent ran\n");
});

test("a composed call carries a summary of its params, and view.activity carries none", (t) => {
  const box = sandbox(t);
  box.write(
    "greet.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "greet someone",
  params: z.object({ name: z.string(), loud: z.boolean() }),
  async run({ params }) {
    return params.loud ? params.name.toUpperCase() : params.name;
  },
});
`,
  );
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";
import greet from "./greet.ts";

export default workflow({
  description: "test",
  params: z.object({}),
  async run(ctx) {
    return await ctx.view.activity("round 1", () =>
      Promise.all([
        greet(ctx, { name: "ada", loud: true }),
        greet(ctx, { name: "${"long".repeat(15)}", loud: false }),
      ]),
    );
  },
});
`,
  );

  assert.equal(box.penguin("run", "./w.ts").code, 0);

  const starts = box
    .events("w-1")
    .filter((event) => event["type"] === "activity" && event["phase"] === "start");
  assert.deepEqual(
    starts.map((event) => [event["label"], event["detail"]]),
    [
      ["round 1", undefined],
      ["greet someone", "name: ada, loud: true"],
      ["greet someone", `name: ${"long".repeat(15).slice(0, 40)}..., loud: false`],
    ],
    "the detail tells two calls of one workflow apart, and a long value is cut",
  );
  assert.deepEqual(
    starts.map((event) => event["parent"]),
    [undefined, starts[0]?.["id"], starts[0]?.["id"]],
  );
});

test("a composed call is one activity and returns its value to the caller", (t) => {
  const box = sandbox(t);
  box.write(
    "double.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "double a number",
  params: z.object({ n: z.number() }),
  async run({ params, view }) {
    view.event({ message: \`the child saw \${params.n}\` });
    return params.n * 2;
  },
});
`,
  );
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";
import double from "./double.ts";

export default workflow({
  description: "test",
  params: z.object({}),
  async run(ctx) {
    const doubled = await double(ctx, { n: 21 });
    return { doubled };
  },
});
`,
  );

  assert.equal(box.penguin("run", "./w.ts").code, 0);

  const events = box.events("w-1");
  const activity = events.find((event) => event["type"] === "activity");
  assert.equal(activity?.["label"], "double a number");
  const inside = events.find((event) => event["type"] === "event");
  assert.equal(inside?.["message"], "the child saw 21");
  assert.equal(inside?.["activity"], activity?.["id"]);
  assert.deepEqual(box.ended("w-1")?.["result"], { doubled: 42 });
});

test("the done event carries what the run function returned", (t) => {
  const box = sandbox(t);
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run() {
    return { verdict: "approved", rounds: 2 };
  },
});
`,
  );

  const done = box.penguin("run", "./w.ts");

  assert.equal(done.code, 0, done.output);
  assert.match(done.stdout, /\{"verdict":"approved","rounds":2\}/);
  assert.deepEqual(box.ended("w-1")?.["result"], { verdict: "approved", rounds: 2 });
});
