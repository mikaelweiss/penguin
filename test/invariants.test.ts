import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { CallEntry, GateEntry, ParkEntry } from "../src/journal.ts";
import { exited, sandbox, waitFor } from "./helpers.ts";

const gateThenCommand = `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ step, gate }) {
    await step.command("sh -c 'echo before >> out.txt'");
    await gate("continue?");
    await step.command("sh -c 'echo pinned >> out.txt'");
  },
});
`;

test("invariant 1: replay executes the pinned copy, not the edited definition", (t) => {
  const box = sandbox(t);
  box.write("w.ts", gateThenCommand);
  assert.equal(box.wa("run", "./w.ts").code, 0);

  box.write("w.ts", gateThenCommand.replace("echo pinned", "echo edited"));
  const resumed = box.wa("resume", "w-1", "go");

  assert.equal(resumed.code, 0);
  assert.deepEqual(box.lines("out.txt"), ["before", "pinned"]);
});

test("invariant 2: the journal is append-only and replay re-executes nothing", (t) => {
  const box = sandbox(t);
  box.write("w.ts", gateThenCommand);
  box.wa("run", "./w.ts");

  const file = path.join(box.runDir("w-1"), "journal.jsonl");
  const parked = fs.readFileSync(file, "utf8");
  box.wa("resume", "w-1", "go");
  const resumed = fs.readFileSync(file, "utf8");

  assert.ok(resumed.startsWith(parked), "the parked journal stayed byte-for-byte the prefix");
  assert.deepEqual(box.lines("out.txt"), ["before", "pinned"]);
});

test("invariant 3: a second process on the same run fails with the holder pid", (t) => {
  const box = sandbox(t);
  box.write("w.ts", gateThenCommand);
  box.wa("run", "./w.ts");

  fs.writeFileSync(path.join(box.runDir("w-1"), "lock"), String(process.pid));
  const blocked = box.wa("resume", "w-1", "go");

  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, new RegExp(`already executing \\(pid ${process.pid}\\)`));
});

test("invariant 4: a run interrupted mid-step resumes from the step boundary", async (t) => {
  const box = sandbox(t);
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ step }) {
    await step.command("sh -c 'echo one >> out.txt'");
    await step.command("sh -c 'sleep 2'");
    await step.command("sh -c 'echo three >> out.txt'");
  },
});
`,
  );

  const child = box.start("run", "./w.ts");
  const journal = path.join(box.runDir("w-1"), "journal.jsonl");
  await waitFor(() => fs.existsSync(journal) && countCalls(box, "w-1") === 1);
  child.kill("SIGINT");
  assert.equal(await exited(child), 130);

  const parked = box.journal("w-1");
  const last = parked[parked.length - 1] as ParkEntry;
  assert.equal(last.type, "park");
  assert.match(last.reason, /interrupted by SIGINT/);
  assert.deepEqual(box.lines("out.txt"), ["one"]);

  const resumed = box.wa("resume", "w-1");
  assert.equal(resumed.code, 0);
  assert.deepEqual(box.lines("out.txt"), ["one", "three"]);
});

test("invariant 5: a gate consumes exactly one answer, and the answer is journaled", (t) => {
  const box = sandbox(t);
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ step, gate }) {
    const first = await gate("first?");
    await step.command(\`sh -c 'echo \${first} >> out.txt'\`);
    const second = await gate("second?");
    await step.command(\`sh -c 'echo \${second} >> out.txt'\`);
  },
});
`,
  );

  box.wa("run", "./w.ts");
  const answered = box.wa("resume", "w-1", "alpha");
  assert.equal(answered.code, 0);
  assert.deepEqual(box.lines("out.txt"), ["alpha"]);

  const midway = box.journal("w-1");
  const gateAnswers = midway.filter(
    (entry): entry is CallEntry => entry.type === "call" && entry.kind === "gate",
  );
  assert.deepEqual(
    gateAnswers.map((entry) => [entry.id, entry.result]),
    [["0", "alpha"]],
  );
  const pending = midway.filter((entry): entry is GateEntry => entry.type === "gate");
  assert.equal(pending[pending.length - 1]?.question, "second?");

  assert.equal(box.wa("resume", "w-1", "beta").code, 0);
  assert.deepEqual(box.lines("out.txt"), ["alpha", "beta"]);
  const finished = box.journal("w-1");
  assert.equal(finished[finished.length - 1]?.type, "done");
  assert.equal(
    finished.filter((entry) => entry.type === "call" && entry.kind === "gate").length,
    2,
  );
});

test("invariant 6: a call that does not match the journal parks before any side effect", (t) => {
  const box = sandbox(t);
  box.write("w.ts", gateThenCommand);
  box.wa("run", "./w.ts");

  const pinned = path.join(box.runDir("w-1"), "workflow.ts");
  fs.writeFileSync(
    pinned,
    fs.readFileSync(pinned, "utf8").replace("echo before", "echo changed"),
  );
  const diverged = box.wa("resume", "w-1", "go");

  assert.equal(diverged.code, 1);
  assert.match(diverged.stdout, /divergence at step 0/);
  assert.deepEqual(box.lines("out.txt"), ["before"]);
  const entries = box.journal("w-1");
  const park = entries[entries.length - 1] as ParkEntry;
  assert.equal(park.type, "park");
  assert.match(park.reason, /divergence at step 0/);
});

test("invariant 7: the engine needs no agent and no definition in an empty home", (t) => {
  const box = sandbox(t);
  assert.deepEqual(fs.readdirSync(box.home), []);

  const listed = box.wa("ps");
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /^RUN\s+WORKFLOW\s+STATE\s+STEP\s+AGE\s+DIRECTORY$/m);

  box.write("skill.md", "do the thing\n");
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ step }) {
    await step.agent("./skill.md");
  },
});
`,
  );
  const parked = box.wa("run", "./w.ts");

  assert.equal(parked.code, 1);
  assert.match(parked.stdout, /no agent is configured/);
  assert.match(parked.stdout, /claude -p/);
  const entries = box.journal("w-1");
  const park = entries[entries.length - 1] as ParkEntry;
  assert.equal(park.type, "park");
  assert.match(park.reason, new RegExp(`${path.join(box.home, "agent")}`));
});

test("invariant 8: the first wa command installs, and a sync keeps what you wrote", (t) => {
  const box = sandbox(t);
  fs.rmSync(box.home, { recursive: true });
  const claude = path.join(box.userHome, ".claude", "skills");
  box.writeSkill(claude, "review", "review it\n");

  const first = box.wa("ps");

  assert.equal(first.code, 0, first.output);
  assert.match(first.stdout, new RegExp(`created ${box.home}`));
  assert.equal(fs.existsSync(path.join(box.home, "runs")), true);
  assert.equal(fs.readlinkSync(path.join(box.home, "skills", "claude")), claude);

  const second = box.wa("ps");
  assert.doesNotMatch(second.stdout, /created /);

  box.writeSkill(path.join(box.home, "skills"), "house-style", "our style\n");
  fs.rmSync(claude, { recursive: true });
  assert.equal(box.wa("sync-skills", "--global").code, 0);

  const kept = fs.readdirSync(path.join(box.home, "skills"));
  assert.equal(kept.includes("claude"), false);
  assert.equal(
    fs.readFileSync(path.join(box.home, "skills", "house-style", "SKILL.md"), "utf8"),
    "our style\n",
  );
});

test("invariant 9: a skill name resolves from the project before the home", (t) => {
  const box = sandbox(t);
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ step }) {
    await step.agent("wa-review");
  },
});
`,
  );
  box.writeSkill(path.join(box.home, "skills"), "wa-review", "the home craft\n");
  box.setAgent(box.agentCommand("none", "prompts.txt"));
  assert.equal(box.wa("run", "./w.ts").code, 0);
  assert.match(box.invocations("prompts.txt")[0] ?? "", /the home craft/);

  box.writeSkill(path.join(box.project, ".wa", "skills"), "wa-review", "the project craft\n");
  assert.equal(box.wa("run", "./w.ts").code, 0);

  assert.match(box.invocations("prompts.txt")[1] ?? "", /the project craft/);
});

function countCalls(box: ReturnType<typeof sandbox>, run: string): number {
  return box.journal(run).filter((entry) => entry.type === "call").length;
}
