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
  box.writeAdapter(
    "clock",
    `import fs from "node:fs";
import { adapter } from "penguin";

export default adapter({
  role: "clock",
  name: "clock",
  description: "test clock",
  build: (host) => ({
    until: (file) =>
      host.wait("new commits", () =>
        new Promise((resolve) => {
          const tick = () => (fs.existsSync(file) ? resolve(file) : setTimeout(tick, 20));
          tick();
        }),
      ),
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
