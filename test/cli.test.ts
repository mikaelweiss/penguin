import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { sandbox } from "./helpers.ts";

const paramsWorkflow = `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  params: z.object({ count: z.number(), dry: z.boolean().default(false), tag: z.string().optional() }),
  async run({ params, step }) {
    await step.command(\`sh -c 'echo \${params.count}:\${params.dry}:\${params.tag ?? "none"} >> out.txt'\`);
  },
});
`;

const gateWorkflow = `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  params: z.object({}),
  async run({ gate }) {
    await gate("keep going?");
  },
});
`;

test("params are coerced to the schema types", (t) => {
  const box = sandbox(t);
  box.write("w.ts", paramsWorkflow);

  assert.equal(box.wa("run", "./w.ts", "--count", "3", "--dry", "--tag", "release").code, 0);
  assert.equal(box.wa("run", "./w.ts", "--count=4", "--no-dry").code, 0);

  assert.deepEqual(box.lines("out.txt"), ["3:true:release", "4:false:none"]);
});

test("a missing param fails before the run is created", (t) => {
  const box = sandbox(t);
  box.write("w.ts", paramsWorkflow);

  const failed = box.wa("run", "./w.ts");

  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /invalid params:/);
  assert.match(failed.stderr, /count:/);
  assert.equal(fs.existsSync(path.join(box.home, "runs")), false);
  assert.equal(box.exists("out.txt"), false, "the run function never ran");
});

test("an unknown param names the params the workflow takes", (t) => {
  const box = sandbox(t);
  box.write("w.ts", paramsWorkflow);

  const failed = box.wa("run", "./w.ts", "--count", "1", "--nope", "x");

  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /unknown param --nope/);
  assert.match(failed.stderr, /--count --dry --tag/);
});

test("a param that needs a number rejects text", (t) => {
  const box = sandbox(t);
  box.write("w.ts", paramsWorkflow);

  const failed = box.wa("run", "./w.ts", "--count", "many");

  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /--count needs a number/);
});

test("run names count up per workflow file", (t) => {
  const box = sandbox(t);
  box.write("w.ts", gateWorkflow);
  box.write("other.ts", gateWorkflow);

  assert.match(box.wa("run", "./w.ts").stdout, /^run w-1$/m);
  assert.match(box.wa("run", "./w.ts").stdout, /^run w-2$/m);
  assert.match(box.wa("run", "./other.ts").stdout, /^run other-1$/m);
  assert.deepEqual(fs.readdirSync(path.join(box.home, "runs")).sort(), [
    "other-1",
    "w-1",
    "w-2",
  ]);
});

test("ps shows the state and the pending gate question", (t) => {
  const box = sandbox(t);
  box.write("w.ts", gateWorkflow);
  box.wa("run", "./w.ts");

  const parked = box.wa("ps");
  assert.equal(parked.code, 0);
  assert.match(parked.stdout, /w-1\s+\S+w\.ts\s+parked\s+gate: keep going\?/);

  fs.writeFileSync(path.join(box.home, "runs", "w-1", "lock"), String(process.pid));
  const running = box.wa("ps");
  assert.match(running.stdout, new RegExp(`w-1\\s+\\S+w\\.ts\\s+running \\(${process.pid}\\)`));
  fs.rmSync(path.join(box.home, "runs", "w-1", "lock"));

  box.wa("resume", "w-1", "yes");
  const finished = box.wa("ps");
  assert.match(finished.stdout, /w-1\s+\S+w\.ts\s+done\s+-/);
  assert.match(finished.stdout, new RegExp(path.join(box.home, "runs", "w-1")));
});

test("resume reports the runs it cannot continue", (t) => {
  const box = sandbox(t);
  box.write("w.ts", gateWorkflow);

  const missing = box.wa("resume", "nothing-1");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no run named nothing-1/);

  box.wa("run", "./w.ts");
  box.wa("resume", "w-1", "yes");
  const done = box.wa("resume", "w-1", "again");
  assert.equal(done.code, 1);
  assert.match(done.stderr, /the run is done/);
});

test("a reply with no pending gate is refused", (t) => {
  const box = sandbox(t);
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  params: z.object({}),
  async run({ step }) {
    await step.command("sh -c 'exit 3'");
    throw new Error("stop here");
  },
});
`,
  );
  box.wa("run", "./w.ts");

  const refused = box.wa("resume", "w-1", "an answer");

  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /no pending gate/);
});

test("a file that exports no workflow is refused", (t) => {
  const box = sandbox(t);
  box.write("w.ts", "export const nothing = 1;\n");

  const failed = box.wa("run", "./w.ts");

  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /does not default-export a workflow/);
  assert.equal(fs.existsSync(path.join(box.home, "runs")), false);
});

test("wa help prints the usage", (t) => {
  const box = sandbox(t);

  const help = box.wa("help");

  assert.equal(help.code, 0);
  assert.match(help.stdout, /wa list \[workflows\|skills\]/);
  assert.match(help.stdout, /wa run <workflow>/);
  assert.match(help.stdout, /wa ps/);
  assert.match(help.stdout, /wa resume <run>/);
  assert.match(help.stdout, /wa sync-skills/);
});
