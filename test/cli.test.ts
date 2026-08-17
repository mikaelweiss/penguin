import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { exited, sandbox } from "./helpers.ts";

const paramsWorkflow = `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({ count: z.number(), dry: z.boolean().default(false), tag: z.string().optional() }),
  async run({ params, shell }) {
    await shell.run(\`sh -c 'echo \${params.count}:\${params.dry}:\${params.tag ?? "none"} >> out.txt'\`);
  },
});
`;

const quickWorkflow = `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ view }) {
    view.event({ message: "nothing to do" });
  },
});
`;

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

test("params are coerced to the schema types", (t) => {
  const box = sandbox(t);
  box.withShell();
  box.write("w.ts", paramsWorkflow);

  assert.equal(box.penguin("run", "./w.ts", "--count", "3", "--dry", "--tag", "release").code, 0);
  assert.equal(box.penguin("run", "./w.ts", "--count=4", "--no-dry").code, 0);

  assert.deepEqual(box.lines("out.txt"), ["3:true:release", "4:false:none"]);
});

test("a bare value fills the next unfilled param, and a boolean is a flag only", (t) => {
  const box = sandbox(t);
  box.withShell();
  box.write("w.ts", paramsWorkflow);

  assert.equal(box.penguin("run", "./w.ts", "3", "release").code, 0);
  assert.equal(box.penguin("run", "./w.ts", "4", "--dry").code, 0);
  assert.equal(box.penguin("run", "./w.ts", "--count", "5", "beta").code, 0);
  assert.equal(box.penguin("run", "./w.ts", "--tag", "rc", "6").code, 0);

  assert.deepEqual(box.lines("out.txt"), ["3:false:release", "4:true:none", "5:false:beta", "6:false:rc"]);

  const failed = box.penguin("run", "./w.ts", "1", "two", "three");

  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /nothing left to fill with three/);
  assert.match(failed.stderr, /count, tag/);
});

test("a missing param fails before the run is created", (t) => {
  const box = sandbox(t);
  box.write("w.ts", paramsWorkflow);

  const failed = box.penguin("run", "./w.ts");

  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /invalid params:/);
  assert.match(failed.stderr, /count:/);
  assert.equal(fs.existsSync(path.join(box.home, "runs")), false);
  assert.equal(box.exists("out.txt"), false, "the run function never ran");
});

test("an unknown param names the params the workflow takes", (t) => {
  const box = sandbox(t);
  box.write("w.ts", paramsWorkflow);

  const failed = box.penguin("run", "./w.ts", "--count", "1", "--nope", "x");

  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /unknown param --nope/);
  assert.match(failed.stderr, /--count --dry --tag/);
});

test("a param that needs a number rejects text", (t) => {
  const box = sandbox(t);
  box.write("w.ts", paramsWorkflow);

  const failed = box.penguin("run", "./w.ts", "--count", "many");

  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /--count needs a number/);
});

test("run names count up per workflow file", (t) => {
  const box = sandbox(t);
  box.write("w.ts", quickWorkflow);
  box.write("other.ts", quickWorkflow);

  assert.match(box.penguin("run", "./w.ts", "--background").stdout, /^run w-1 started,/m);
  assert.match(box.penguin("run", "./w.ts", "--background").stdout, /^run w-2 started,/m);
  assert.match(box.penguin("run", "./other.ts", "--background").stdout, /^run other-1 started,/m);

  assert.deepEqual(fs.readdirSync(path.join(box.home, "runs")).sort(), ["other-1", "w-1", "w-2"]);
});

test("a run starts by naming the run and the agent adapter", (t) => {
  const box = sandbox(t);
  box.write("w.ts", quickWorkflow);

  const bare = box.penguin("run", "./w.ts");
  assert.equal(bare.code, 0, bare.output);
  assert.match(bare.stdout, /^run w-1 started, no agent adapter is installed$/m);

  box.setAgent("none");
  const watched = box.penguin("run", "./w.ts");
  assert.match(watched.stdout, /^run w-2 started, agent fake$/m);

  const background = box.penguin("run", "./w.ts", "--background");
  assert.equal(background.code, 0, background.output);
  assert.equal(background.stdout, "run w-3 started, agent fake\n");
});

test("ps lists the live runs as a table, and never a done one", async (t) => {
  const box = sandbox(t);
  box.write("w.ts", gateWorkflow);
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

  const live = box.penguin("ps");

  assert.equal(live.code, 0, live.output);
  const rows = live.stdout.split("\n").filter((line) => line.trim() !== "");
  assert.equal(rows.length, 2, live.stdout);
  assert.match(rows[0] ?? "", /^RUN\s+WORKFLOW\s+STATE\s+DETAIL\s+AGE\s+DIRECTORY$/);
  assert.match(rows[1] ?? "", /^w-1\s+\S+w\.ts\s+blocked\s+keep going\?\s+\d+s\s+\S+runs\/w-1$/);

  box.send("w-1", "yes");
  await box.waitForEnd("w-1");

  const finished = box.penguin("ps");
  assert.equal(finished.stdout.split("\n").filter((line) => line.trim() !== "").length, 1);
  assert.doesNotMatch(finished.stdout, /w-1/);
});

test("ps with no live run prints the header alone", (t) => {
  const box = sandbox(t);

  const empty = box.penguin("ps");

  assert.equal(empty.code, 0);
  assert.equal(empty.stdout, "RUN  WORKFLOW  STATE  DETAIL  AGE  DIRECTORY\n");
});

test("attach follows a live run and leaves when the run ends", async (t) => {
  const box = sandbox(t);
  box.write("w.ts", gateWorkflow);
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

  const viewer = box.start("attach", "w-1");
  let shown = "";
  viewer.stdout?.on("data", (chunk: Buffer) => {
    shown += chunk.toString();
  });
  box.send("w-1", "yes");
  const code = await exited(viewer);

  assert.equal(code, 0);
  assert.match(shown, /gate: keep going\?/);
  assert.match(shown, /^> yes$/m);
  assert.match(shown, /^yes$/m);
  assert.equal((await box.waitForEnd("w-1"))["phase"], "done");
});

test("attach names the runs it cannot open", (t) => {
  const box = sandbox(t);

  const bare = box.penguin("attach");
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /pn attach needs a run name/);

  const missing = box.penguin("attach", "nothing-1");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no run named nothing-1/);
});

test("pn help prints the usage", (t) => {
  const box = sandbox(t);

  const help = box.penguin("help");

  assert.equal(help.code, 0);
  assert.match(help.stdout, /pn list workflows\|skills\|adapters \[--verbose\]/);
  assert.match(help.stdout, /pn run <workflow> \[--param value \.\.\.\]/);
  assert.match(help.stdout, /pn run <workflow> --background/);
  assert.match(help.stdout, /pn ps/);
  assert.match(help.stdout, /pn attach <run>/);
  assert.match(help.stdout, /pn sync-skills/);
  assert.match(help.stdout, /q detaches, Ctrl-C stops the run/);
  assert.doesNotMatch(help.stdout, /resume/);
});

test("an unknown command names it and prints the usage", (t) => {
  const box = sandbox(t);

  const failed = box.penguin("continue", "w-1");

  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /unknown command continue/);
  assert.match(failed.stderr, /usage:/);
});

test("a workflow with no description fails to load", (t) => {
  const box = sandbox(t);
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  params: z.object({}),
  async run() {},
});
`,
  );

  const failed = box.penguin("run", "./w.ts");

  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /needs a description/);
});

test("a file that exports no workflow is refused", (t) => {
  const box = sandbox(t);
  box.write("w.ts", "export const nothing = 1;\n");

  const failed = box.penguin("run", "./w.ts");

  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /does not default-export a workflow/);
  assert.equal(fs.existsSync(path.join(box.home, "runs")), false);
});

test("list adapters shows role, name, and description", (t) => {
  const box = sandbox(t);
  box.withShell();
  box.setAgent("none");

  const listed = box.penguin("list", "adapters");

  assert.equal(listed.code, 0, listed.output);
  assert.match(listed.stdout, /^agent {2}fake\n {2}fake test agent$/m);
  assert.match(listed.stdout, /^shell {2}shell\n {2}test shell$/m);

  const verbose = box.penguin("list", "adapters", "--verbose");
  assert.match(verbose.stdout, /^ {2}global {2}\S+adapters\/fake\.ts$/m);
});

test("list adapters with none installed says where they go", (t) => {
  const box = sandbox(t);

  const empty = box.penguin("list", "adapters");

  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /no adapter file in/);
});

test("run and list adapters write the penguin-env declaration", (t) => {
  const box = sandbox(t);
  box.withShell();
  box.penguin("list", "adapters");

  const env = fs.readFileSync(path.join(box.home, "penguin-env.d.ts"), "utf8");
  assert.match(env, /declare module "penguin"/);
  assert.match(env, /shell: ReturnType<\(typeof adapter0\)\["build"\]>;/);
  assert.match(env, /\.\/adapters\/shell\.ts/);
});
