import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { allocateRun, discardRun, finishRun, readRun } from "../src/create.ts";
import { rows } from "../src/runs.ts";
import { type Left, RunView } from "../src/tui/run-view.tsx";
import { homed, paste, press, screen } from "./drive.tsx";
import { type Event, sandbox, waitFor } from "./helpers.ts";

const gateWorkflow = `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ gate }) {
    return await gate("keep going?");
  },
});
`;

test("invariant 1: at most one process executes a run", async (t) => {
  const box = sandbox(t);
  box.write("w.ts", gateWorkflow);
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");
  const holder = box.holder("w-1");
  assert.ok(holder !== undefined, "the live run holds the lock");

  const second = box.penguin("_run", "w-1");

  assert.equal(second.code, 1);
  assert.match(second.stderr, new RegExp(`run w-1 is already executing \\(pid ${holder}\\)`));
  assert.equal(box.holder("w-1"), holder, "the refused process left the lock alone");
  box.send("w-1", "yes");
  assert.equal((await box.waitForEnd("w-1"))["phase"], "done");
});

test("invariant 2: a viewer that joins late renders the same story", (t) => {
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
    view.event({ message: "starting" });
    await view.activity("round 1", async () => {
      await shell.run("sh -c 'echo hi'");
      view.fact({ round: "1/1" });
    });
    view.artifact({ title: "the note", path: "note.md" });
    return "finished";
  },
});
`,
  );

  const live = box.penguin("run", "./w.ts");
  const late = box.penguin("attach", "w-1");

  assert.equal(live.code, 0, live.output);
  assert.equal(late.code, 0, late.output);
  assert.equal(late.stdout, live.stdout);
  assert.match(live.stdout, /run w-1 started/);
  assert.match(live.stdout, /^round 1$/m);
  assert.match(live.stdout, /^step 0 shell\.run$/m);
  assert.match(live.stdout, /^round: 1\/1$/m);
  assert.match(live.stdout, /^artifact: the note \(note\.md\)$/m);
  assert.match(live.stdout, /^finished$/m);
  const types = box.events("w-1").map((event) => event["type"]);
  assert.deepEqual(types, [
    "run",
    "event",
    "activity",
    "step",
    "state",
    "step",
    "state",
    "fact",
    "activity",
    "artifact",
    "run",
  ]);
});

test("invariant 3: q detaches and the run continues", async (t) => {
  const box = sandbox(t);
  box.write("w.ts", gateWorkflow);
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");
  const holder = box.holder("w-1");

  homed(t, box.home);
  const left: Left[] = [];
  const setup = await screen(
    <RunView name="w-1" agent="agent fake" canReturn={false} onLeave={(one) => left.push(one)} />,
  );
  try {
    const shown = await setup.waitForFrame((text) => text.includes("keep going?"));
    assert.match(shown, /keep going\?/);
    await press(setup, ["q"]);
  } finally {
    setup.renderer.destroy();
  }

  assert.deepEqual(
    left.map((one) => one.code),
    [0],
  );
  assert.equal(box.holder("w-1"), holder, "the run kept the lock");
  assert.equal(box.lastState("w-1")?.["state"], "blocked");
  box.send("w-1", "yes");
  assert.equal((await box.waitForEnd("w-1"))["phase"], "done");
});

test("invariant 3: Ctrl-C stops the run, and the stop is recorded", async (t) => {
  const box = sandbox(t);
  box.write("w.ts", gateWorkflow);
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");
  const holder = box.holder("w-1") as number;

  process.kill(holder, "SIGTERM");
  const ended = await box.waitForEnd("w-1");

  assert.equal(ended["phase"], "stopped");
  await waitFor(() => box.holder("w-1") === undefined);
  assert.equal(fs.existsSync(path.join(box.runDir("w-1"), "lock")), false);
});

test("invariant 4: done is final, and attach to a done run is read-only", (t) => {
  const box = sandbox(t);
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ view }) {
    view.event({ message: "the only step" });
  },
});
`,
  );
  assert.equal(box.penguin("run", "./w.ts").code, 0);
  const file = path.join(box.runDir("w-1"), "events.jsonl");
  const story = fs.readFileSync(file, "utf8");

  const attached = box.penguin("attach", "w-1");

  assert.equal(attached.code, 0, attached.output);
  assert.match(attached.stdout, /the only step/);
  assert.equal(fs.readFileSync(file, "utf8"), story, "attach added no event");
  assert.equal(fs.readFileSync(path.join(box.runDir("w-1"), "inbox.jsonl"), "utf8"), "");
  assert.equal(box.holder("w-1"), undefined);

  const listed = box.penguin("ps");
  assert.equal(listed.code, 0);
  assert.doesNotMatch(listed.stdout, /^w-1\b/m, "a done run never lists");

  const revived = box.penguin("resume", "w-1", "go");
  assert.equal(revived.code, 1);
  assert.match(revived.stderr, /unknown command resume/);
});

test("invariant 5: each message at most once, in order, and each ask consumes one", async (t) => {
  const box = sandbox(t);
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ gate, messages }) {
    const answer = await gate("first?");
    const choice = await gate("second?", z.enum(["dev", "prod"]));
    const last = await messages.next();
    return [answer, choice, last.text].join("|");
  },
});
`,
  );
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

  box.send("w-1", "one");
  box.send("w-1", "nope");
  box.send("w-1", "prod");
  box.send("w-1", "three");
  const ended = await box.waitForEnd("w-1");

  assert.equal(ended["result"], "one|prod|three");
  const events = box.events("w-1");
  assert.deepEqual(
    events.filter((event) => event["type"] === "message").map((event) => event["text"]),
    ["one", "nope", "prod", "three"],
  );
  assert.equal(
    events.filter((event) => event["phase"] === "asked").length,
    3,
    "three asks took three messages",
  );
  const answered = events.filter((event) => event["phase"] === "answered");
  assert.deepEqual(
    answered.map((event) => [event["question"], event["answer"]]),
    [
      ["first?", "one"],
      ["second?", "prod"],
    ],
  );
});

test("invariant 5: a message answers the gate it addresses, an unaddressed one the earliest", async (t) => {
  const box = sandbox(t);
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ gate }) {
    const [first, second] = await Promise.all([gate("first?"), gate("second?")]);
    return \`\${first}|\${second}\`;
  },
});
`,
  );
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await waitFor(() => asks(box.events("w-1")).length === 2);

  const second = asks(box.events("w-1")).find((event) => event["question"] === "second?");
  box.send("w-1", "two", undefined, String(second?.["id"]));
  await waitFor(() => answers(box.events("w-1")).length === 1);

  const answered = answers(box.events("w-1"))[0];
  assert.deepEqual(
    [answered?.["id"], answered?.["question"], answered?.["answer"]],
    [second?.["id"], "second?", "two"],
    "the addressed gate took it, not the earlier one",
  );
  assert.equal(box.ended("w-1"), undefined, "the first gate is still asked");
  assert.equal(box.lastState("w-1")?.["detail"], "first?");

  box.send("w-1", "one");
  const ended = await box.waitForEnd("w-1");

  assert.equal(ended["result"], "one|two");
  assert.deepEqual(
    answers(box.events("w-1")).map((event) => event["answer"]),
    ["two", "one"],
  );
});

test("invariant 18: a message to a gate no reader holds waits in the queue", async (t) => {
  const box = sandbox(t);
  box.withClock();
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({ file: z.string() }),
  async run({ params, clock, gate }) {
    await clock.until(params.file);
    const first = await gate("first?");
    const second = await gate("second?");
    return \`\${first}|\${second}\`;
  },
});
`,
  );
  const file = path.join(box.project, "commit.txt");
  assert.equal(box.penguin("run", "./w.ts", "--file", file, "--background").code, 0);
  await box.waitForState("w-1", "idle");

  box.send("w-1", "ghost", undefined, "g99");
  await waitFor(() => box.events("w-1").some((event) => event["type"] === "message"));

  assert.deepEqual(answers(box.events("w-1")), [], "no gate holds g99, so nothing answered");
  assert.equal(box.lastState("w-1")?.["state"], "idle");

  fs.writeFileSync(file, "");
  await box.waitForState("w-1", "blocked");

  assert.equal(box.lastState("w-1")?.["detail"], "second?", "the first gate took the queued message");
  assert.deepEqual(
    answers(box.events("w-1")).map((event) => [event["question"], event["answer"]]),
    [["first?", "ghost"]],
    "the queued message answered one gate, and only one",
  );

  box.send("w-1", "again");
  const ended = await box.waitForEnd("w-1");

  assert.equal(ended["result"], "ghost|again");
});

test("invariant 17: every placed event carries its activity, and waits pair", async (t) => {
  const box = sandbox(t);
  box.withShell();
  box.withClock();
  box.setAgent("none");
  box.write("skill.md", "do the thing\n");
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({ file: z.string() }),
  async run({ params, agent, clock, gate, shell, view }) {
    await view.activity("round 1", async () => {
      await shell.run("true");
      await agent().run("./skill.md");
      await clock.until(params.file);
      await gate("go on?");
    });
    return "over";
  },
});
`,
  );
  const file = path.join(box.project, "commit.txt");
  assert.equal(box.penguin("run", "./w.ts", "--file", file, "--background").code, 0);
  await box.waitForState("w-1", "idle");
  fs.writeFileSync(file, "");
  await box.waitForState("w-1", "blocked");
  box.send("w-1", "yes");
  assert.equal((await box.waitForEnd("w-1"))["result"], "over");

  const events = box.events("w-1");
  const activity = events.find((event) => event["type"] === "activity");
  const placed = events.filter((event) =>
    ["session", "agent", "gate", "step", "wait"].includes(String(event["type"])),
  );
  assert.ok(placed.length >= 8, `too few placed events: ${placed.length}`);
  for (const event of placed) {
    assert.equal(event["activity"], activity?.["id"], JSON.stringify(event));
  }
  const waits = events.filter((event) => event["type"] === "wait");
  assert.deepEqual(
    waits.map((event) => [event["phase"], event["id"], event["label"]]),
    [
      ["start", "w0", "new commits"],
      ["end", "w0", undefined],
    ],
  );
});

test("invariant 6: turn.stop kills the agent process, and the next turn continues", async (t) => {
  const box = sandbox(t);
  box.setAgent("none", "prompts.txt");
  box.write("skill.md", "do the thing\n");
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ agent, messages }) {
    const worker = agent({ name: "worker" });
    const turn = worker.run("./skill.md", { input: "<slow>" });
    await messages.next();
    await turn.stop();
    await worker.run("./skill.md", { input: "carry on" });
    return "continued";
  },
});
`,
  );

  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await waitFor(() => box.exists("slow.pid"));
  const child = Number(box.read("slow.pid").trim());
  assert.equal(alive(child), true, "the agent process is running");

  box.send("w-1", "stop that");
  const ended = await box.waitForEnd("w-1");

  assert.equal(ended["result"], "continued");
  assert.equal(alive(child), false, "the stop killed the agent process");
  assert.equal(box.exists("late.txt"), false, "the killed process never finished its work");
  const turns = box.sessions();
  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns.map((turn) => turn.first),
    [true, false],
    "the next turn continued the same conversation",
  );
  assert.equal(turns[0]?.session, turns[1]?.session);
});

test("invariant 7: a call validates the callee params before the callee runs", (t) => {
  const box = sandbox(t);
  box.write(
    "double.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "double a number",
  params: z.object({ n: z.number() }),
  async run({ params, view }) {
    view.event({ message: "the child ran" });
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
    return await double(ctx, { n: "twenty one" });
  },
});
`,
  );

  const failed = box.penguin("run", "./w.ts");

  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /invalid params for the workflow "double a number"/);
  assert.match(failed.stdout, /n: /);
  const events = box.events("w-1");
  assert.equal(
    events.some((event) => event["message"] === "the child ran"),
    false,
    "the callee never started",
  );
  assert.equal(
    events.some((event) => event["type"] === "activity"),
    false,
    "the call failed before the callee's activity",
  );
});

test("invariant 7: a composed call creates no run", async (t) => {
  const box = sandbox(t);
  box.write(
    "ask.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "ask the human",
  params: z.object({}),
  async run({ gate }) {
    return await gate("go on?");
  },
});
`,
  );
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";
import ask from "./ask.ts";

export default workflow({
  description: "test",
  params: z.object({}),
  async run(ctx) {
    const answer = await ask(ctx, {});
    return \`the child said \${answer}\`;
  },
});
`,
  );

  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

  assert.deepEqual(fs.readdirSync(path.join(box.home, "runs")), ["w-1"]);
  const listed = box.penguin("ps");
  const rows = listed.stdout.split("\n").filter((line) => line.trim() !== "");
  assert.equal(rows.length, 2, listed.stdout);
  assert.match(rows[1] ?? "", /^w-1\s/);

  box.send("w-1", "yes");
  const ended = await box.waitForEnd("w-1");
  assert.equal(ended["result"], "the child said yes");
  const activity = box.events("w-1").find((event) => event["type"] === "activity");
  assert.equal(activity?.["label"], "ask the human");
});

test("invariant 8: the engine depends on no adapter and no definition", (t) => {
  const box = sandbox(t);
  assert.deepEqual(fs.readdirSync(box.home), []);

  const listed = box.penguin("ps");
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /^RUN\s+WORKFLOW\s+STATE\s+DETAIL\s+AGE\s+DIRECTORY$/m);

  box.write(
    "role.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ shell }) {
    await shell.run("true");
  },
});
`,
  );
  const missing = box.penguin("run", "./role.ts");
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /nothing provides ctx\.shell/);
  assert.match(missing.stdout, /Installed adapter roles: agent/);
  assert.match(String(box.ended("role-1")?.["reason"]), /nothing provides ctx\.shell/);

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
  const agentless = box.penguin("run", "./w.ts");
  assert.equal(agentless.code, 1);
  assert.match(agentless.stdout, /no agent adapter is installed/);
  assert.match(agentless.stdout, /pn list adapters/);
  assert.match(String(box.ended("w-1")?.["reason"]), /no agent adapter is installed/);
});

test("invariant 9: the first penguin command installs, and sync keeps a skill you wrote", (t) => {
  const box = sandbox(t);
  fs.rmSync(box.home, { recursive: true });
  const claude = path.join(box.userHome, ".claude", "skills");
  box.writeSkill(claude, "review", "review it\n");

  const first = box.penguin("ps");

  assert.equal(first.code, 0, first.output);
  assert.match(first.stdout, new RegExp(`created ${box.home}`));
  assert.equal(fs.existsSync(path.join(box.home, "runs")), true);
  assert.equal(fs.existsSync(path.join(box.home, "adapters", "claude.ts")), true);
  assert.equal(fs.readlinkSync(path.join(box.home, "skills", "claude")), claude);

  const second = box.penguin("ps");
  assert.doesNotMatch(second.stdout, /created /);

  box.writeSkill(path.join(box.home, "skills"), "house-style", "our style\n");
  fs.rmSync(claude, { recursive: true });
  assert.equal(box.penguin("sync-skills", "--global").code, 0);

  const kept = fs.readdirSync(path.join(box.home, "skills"));
  assert.equal(kept.includes("claude"), false, "a link to a directory that is gone disappears");
  assert.equal(
    fs.readFileSync(path.join(box.home, "skills", "house-style", "SKILL.md"), "utf8"),
    "our style\n",
  );
});

test("invariant 10: a skill name resolves from the project before the home", (t) => {
  const box = sandbox(t);
  box.setAgent("none", "prompts.txt");
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ agent }) {
    await agent().run("penguin-review");
  },
});
`,
  );
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "penguin-review", "the claude craft\n");
  box.writeSkill(path.join(box.userHome, ".agents", "skills"), "penguin-review", "the agents craft\n");
  assert.equal(box.penguin("sync-skills", "--global").code, 0);

  assert.equal(box.penguin("run", "./w.ts").code, 0);
  assert.match(box.invocations("prompts.txt")[0] ?? "", /the claude craft/);

  fs.writeFileSync(path.join(box.home, "skills", ".order"), "agents\nclaude\n");
  assert.equal(box.penguin("run", "./w.ts").code, 0);
  assert.match(box.invocations("prompts.txt")[1] ?? "", /the agents craft/);

  box.writeSkill(path.join(box.home, "skills"), "penguin-review", "the home craft\n");
  assert.equal(box.penguin("run", "./w.ts").code, 0);
  assert.match(box.invocations("prompts.txt")[2] ?? "", /the home craft/);

  box.writeSkill(path.join(box.project, ".penguin", "skills"), "penguin-review", "the project craft\n");
  assert.equal(box.penguin("run", "./w.ts").code, 0);
  assert.match(box.invocations("prompts.txt")[3] ?? "", /the project craft/);
});

test("invariant 10: a skill path resolves against the workflow file", (t) => {
  const box = sandbox(t);
  box.setAgent("none", "prompts.txt");
  box.write("flows/skills/penguin-review.md", "the craft next to the workflow\n");
  box.writeSkill(path.join(box.home, "skills"), "penguin-review", "the home craft\n");
  box.write(
    "flows/w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ agent }) {
    await agent().run("./skills/penguin-review.md");
  },
});
`,
  );

  assert.equal(box.penguin("run", "./flows/w.ts").code, 0);

  assert.match(box.invocations("prompts.txt")[0] ?? "", /the craft next to the workflow/);
});

test("invariant 10: an adapter resolves from the project before the home", (t) => {
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
    run: () => ({ code: 0, stdout: "the project shell", stderr: "" }),
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

  assert.equal(box.ended("w-1")?.["result"], "the project shell");
});

test("invariant 11: a typed gate validates the answer and asks again on a mismatch", async (t) => {
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
    return { port, kind: typeof port };
  },
});
`,
  );
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

  box.send("w-1", "eighty");
  await waitFor(() => asks(box.events("w-1")).length === 2);

  assert.equal(box.ended("w-1"), undefined, "the mismatch kept the run alive");
  const warned = box.events("w-1").find((event) => event["level"] === "warn");
  assert.match(String(warned?.["message"]), /the answer "eighty" does not fit/);
  assert.equal(box.lastState("w-1")?.["detail"], "Port?");

  box.send("w-1", "8080");
  const ended = await box.waitForEnd("w-1");

  assert.deepEqual(ended["result"], { port: 8080, kind: "number" });
  const events = box.events("w-1");
  assert.deepEqual(
    asks(events).map((event) => event["schema"]),
    [
      { type: "number", minimum: 1, maximum: 65535 },
      { type: "number", minimum: 1, maximum: 65535 },
    ],
    "every ask carries the shape",
  );
  assert.deepEqual(
    events.filter((event) => event["phase"] === "answered").map((event) => event["answer"]),
    ["8080"],
    "only the answer that fits is an answer",
  );
});

test("invariant 13: a blocked turn resolves exactly one envelope, and both is a mismatch", async (t) => {
  const box = sandbox(t);
  box.setAgent('{"result":{"go":true},"blocked":{"questions":["which?"]}}', "prompts.txt");
  box.write("skill.md", "decide\n");
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ agent }) {
    await agent().run("./skill.md", {
      result: z.object({ go: z.boolean() }),
      blocked: z.object({ questions: z.array(z.string()) }),
    });
  },
});
`,
  );

  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

  const prompts = box.invocations("prompts.txt");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /# Correction/);
  assert.match(String(box.lastState("w-1")?.["detail"]), /failed twice/);

  process.kill(box.holder("w-1") as number, "SIGTERM");
  assert.equal((await box.waitForEnd("w-1"))["phase"], "stopped");
});

function asks(events: Event[]): Event[] {
  return events.filter((event) => event["phase"] === "asked");
}

function answers(events: Event[]): Event[] {
  return events.filter((event) => event["phase"] === "answered");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("invariant 14: an unfinished run directory is invisible, and discard spares a finished one", (t) => {
  const box = sandbox(t);
  const was = process.env["PENGUIN_HOME"];
  process.env["PENGUIN_HOME"] = box.home;
  t.after(() => {
    if (was === undefined) delete process.env["PENGUIN_HOME"];
    else process.env["PENGUIN_HOME"] = was;
  });
  const file = path.join(box.project, "w.ts");

  const { name, dir } = allocateRun(file);
  assert.equal(name, "w-1");
  assert.equal(rows(Date.now()).length, 0, "ps never lists an allocated directory");
  assert.throws(() => readRun(dir), /no run at/, "attach cannot open it");

  discardRun(dir);
  assert.equal(fs.existsSync(dir), false);

  const again = allocateRun(file);
  finishRun(again.dir, file, { count: 1 });
  assert.deepEqual(readRun(again.dir).params, { count: 1 });
  discardRun(again.dir);
  assert.equal(fs.existsSync(again.dir), true, "a finished run survives discard");
});

const SENTINEL = "onlyonce";

const watchingWorkflow = `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ gate, view }) {
    view.watch({ elapsed: true });
    view.fact({ round: 1 });
    return await gate("### Blockers\\n\\n- the strip covers the controls, ${SENTINEL}\\n\\n### Non-blockers\\n\\n- the cursor lies");
  },
});
`;

const nothing = (): void => {};

test("invariant 16: the status line holds one line, however long the question", async (t) => {
  const box = sandbox(t);
  box.write("w.ts", watchingWorkflow);
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

  homed(t, box.home);
  const setup = await screen(<RunView name="w-1" agent="agent fake" canReturn={false} onLeave={nothing} />);
  try {
    const frame = await setup.waitForFrame(
      (text) => text.includes("blocked: Blockers") && text.includes(SENTINEL),
    );
    const status = frame.split("\n").filter((row) => row.includes("blocked: Blockers"));
    assert.equal(status.length, 1, "the status prints once, one line");
    assert.ok((status[0] ?? "").length <= 100, "the status stays inside the width");
    assert.match(status[0] ?? "", /round 1/, "the status carries the facts");
  } finally {
    setup.renderer.destroy();
  }
  box.send("w-1", "ok");
  await box.waitForEnd("w-1");
});

test("invariant 16: the input bar holds the bottom of the screen", async (t) => {
  const box = sandbox(t);
  box.write("w.ts", watchingWorkflow);
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

  homed(t, box.home);
  const setup = await screen(<RunView name="w-1" agent="agent fake" canReturn={false} onLeave={nothing} />);
  try {
    const frame = await setup.waitForFrame((text) => text.includes("answer: Blockers"));
    const rows = frame.trimEnd().split("\n");
    assert.match(rows.at(-1) ?? "", /enter sends|type to send/, "the input hint is the last row");
    assert.match(rows.at(-2) ?? "", /answer: Blockers/, "the input bar sits above it");
    assert.match(rows.at(-3) ?? "", /blocked: Blockers/, "the status sits above the input");
  } finally {
    setup.renderer.destroy();
  }
  box.send("w-1", "ok");
  await box.waitForEnd("w-1");
});

test("invariant 15: a paste sends as one message, newlines kept", async (t) => {
  const box = sandbox(t);
  box.write("w.ts", gateWorkflow);
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

  homed(t, box.home);
  const left: Left[] = [];
  const setup = await screen(
    <RunView name="w-1" agent="agent fake" canReturn={false} onLeave={(one) => left.push(one)} />,
  );
  let ended: Event;
  try {
    await setup.waitForFrame((text) => text.includes("keep going?"));
    await paste(setup, "line one\nline two");
    await press(setup, ["RETURN"]);
    ended = await box.waitForEnd("w-1");
  } finally {
    setup.renderer.destroy();
  }

  assert.equal(ended["result"], "line one\nline two");
  const sent = fs
    .readFileSync(path.join(box.runDir("w-1"), "inbox.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  assert.equal(sent.length, 1);
});

test("invariant 15: a collapsed paste sends its full text, never the token", async (t) => {
  const box = sandbox(t);
  box.write("w.ts", gateWorkflow);
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

  const big = Array.from({ length: 10 }, (_, n) => `line ${n}`).join("\n");
  homed(t, box.home);
  const setup = await screen(<RunView name="w-1" agent="agent fake" canReturn={false} onLeave={nothing} />);
  let ended: Event;
  try {
    await setup.waitForFrame((text) => text.includes("keep going?"));
    await paste(setup, big);
    await setup.waitForFrame((text) => text.includes("[pasted #1, 10 lines]"));
    await press(setup, ["RETURN"]);
    ended = await box.waitForEnd("w-1");
  } finally {
    setup.renderer.destroy();
  }

  assert.equal(ended["result"], big);
  const sent = fs.readFileSync(path.join(box.runDir("w-1"), "inbox.jsonl"), "utf8");
  assert.doesNotMatch(sent, /pasted #1/);
});
