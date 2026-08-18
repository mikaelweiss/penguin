import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { starterCatalog } from "@mikaelweiss/penguin-engine";
import { sandbox } from "./helpers.ts";

test("a fresh install enables the starter catalog and does not copy it", (t) => {
  const box = sandbox(t);
  fs.rmSync(box.home, { recursive: true });

  const first = box.penguin("ps");

  assert.equal(first.code, 0, first.output);
  assert.equal(fs.readFileSync(path.join(box.home, "catalogs"), "utf8"), "starter\n");
  assert.equal(fs.existsSync(path.join(box.home, "ship.ts")), false);
  assert.equal(fs.existsSync(path.join(box.home, "skills", "penguin-triage", "SKILL.md")), false);
  assert.equal(fs.existsSync(path.join(box.home, "tsconfig.json")), true);
  for (const name of ["claude", "codex", "cursor", "opencode", "git", "gh"]) {
    assert.equal(fs.existsSync(path.join(box.home, "adapters", `${name}.ts`)), false, name);
  }
  assert.equal(fs.readFileSync(path.join(box.home, "defaults"), "utf8"), "agent claude\n");
  const env = fs.readFileSync(path.join(box.home, "penguin-env.d.ts"), "utf8");
  assert.match(env, /github: ReturnType/);
  assert.match(env, /vcs: ReturnType/);
});

test("a fresh install chooses the claude agent in the defaults file", (t) => {
  const box = sandbox(t);
  fs.rmSync(box.home, { recursive: true });

  const first = box.penguin("ps");

  assert.equal(first.code, 0, first.output);
  assert.equal(fs.readFileSync(path.join(box.home, "defaults"), "utf8"), "agent claude\n");
});

test("install keeps the defaults file a home already has", (t) => {
  const box = sandbox(t);
  box.setDefaults("agent mine");

  const again = box.penguin("install");

  assert.equal(again.code, 0, again.output);
  assert.equal(fs.readFileSync(path.join(box.home, "defaults"), "utf8"), "agent mine\n");
});

test("a fresh install leaves ship in the workflow list, from examples/", (t) => {
  const box = sandbox(t);
  fs.rmSync(box.home, { recursive: true });
  box.penguin("ps");

  const listed = box.penguin("list", "workflows", "--verbose");

  assert.equal(listed.code, 0, listed.output);
  assert.match(
    listed.stdout,
    /^ship {2}--ticket <text> \[--rounds <number>\]\n {2}ticket to open pull request:/m,
  );
  assert.match(listed.stdout, new RegExp(path.join(starterCatalog().dir, "ship.ts")));
});

test("a home workflow of the same name overlays the starter", (t) => {
  const box = sandbox(t);
  fs.rmSync(box.home, { recursive: true });
  box.penguin("ps");
  fs.writeFileSync(
    path.join(box.home, "ship.ts"),
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "the home ship",
  params: z.object({}),
  async run() {},
});
`,
  );

  const listed = box.penguin("list", "workflows", "--verbose");

  assert.equal(listed.code, 0, listed.output);
  assert.match(listed.stdout, /the home ship/);
  assert.match(listed.stdout, new RegExp(path.join(box.home, "ship.ts")));
});

test("a run on a fresh install picks the default agent", (t) => {
  const box = sandbox(t);
  fs.rmSync(box.home, { recursive: true });
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ agent }) {
    agent();
    return "opened";
  },
});
`,
  );

  const done = box.penguin("run", "./w.ts");

  assert.equal(done.code, 0, done.output);
  assert.match(done.stdout, /^run w-1 started, agent claude$/m);
});

test("install on a home that exists copies nothing and enables nothing", (t) => {
  const box = sandbox(t);

  const again = box.penguin("install");

  assert.equal(again.code, 0, again.output);
  assert.match(again.stdout, /penguin home is/);
  assert.match(again.stdout, /pn list workflows/);
  assert.equal(fs.existsSync(path.join(box.home, "ship.ts")), false);
  assert.equal(fs.existsSync(path.join(box.home, "catalogs")), false);
});

test("a fresh install prints the two lines and no skills report", (t) => {
  const box = sandbox(t);
  fs.rmSync(box.home, { recursive: true });
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "review it\n");

  const first = box.penguin("ps");

  assert.equal(first.code, 0, first.output);
  assert.match(first.stdout, new RegExp(`^created ${box.home}$`, "m"));
  assert.match(first.stdout, /^run `pn list workflows` to see what's available/m);
  assert.match(first.stdout, /`pn run <workflow>` from a project directory to get started$/m);
  assert.doesNotMatch(first.stdout, /skills in /);
  assert.doesNotMatch(first.stdout, /no \.claude\/skills/);
});
