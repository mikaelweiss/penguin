import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { sandbox } from "./helpers.ts";

test("a fresh install fills the home with the catalog", (t) => {
  const box = sandbox(t);
  fs.rmSync(box.home, { recursive: true });

  const first = box.penguin("ps");

  assert.equal(first.code, 0, first.output);
  assert.equal(fs.existsSync(path.join(box.home, "ticket.ts")), true);
  assert.equal(fs.existsSync(path.join(box.home, "skills", "penguin-triage", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(box.home, "tsconfig.json")), true);
  for (const name of ["claude", "git", "gh", "terminal"]) {
    assert.equal(fs.existsSync(path.join(box.home, "adapters", `${name}.ts`)), true, name);
  }
  const env = fs.readFileSync(path.join(box.home, "penguin-env.d.ts"), "utf8");
  assert.match(env, /github: ReturnType/);
  assert.match(env, /vcs: ReturnType/);
});

test("a fresh install leaves ticket in the workflow list", (t) => {
  const box = sandbox(t);
  fs.rmSync(box.home, { recursive: true });
  box.penguin("ps");

  const listed = box.penguin("list", "workflows");

  assert.equal(listed.code, 0, listed.output);
  assert.match(listed.stdout, /^ticket {2}--ticket <text>\n {2}ticket to merged PR:/m);});

test("install on a home that exists copies nothing", (t) => {
  const box = sandbox(t);

  const again = box.penguin("install");

  assert.equal(again.code, 0, again.output);
  assert.match(again.stdout, /penguin home is/);
  assert.match(again.stdout, /penguin list workflows/);
  assert.equal(fs.existsSync(path.join(box.home, "ticket.ts")), false);
});

test("a fresh install prints the two lines and no skills report", (t) => {
  const box = sandbox(t);
  fs.rmSync(box.home, { recursive: true });
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "review it\n");

  const first = box.penguin("ps");

  assert.equal(first.code, 0, first.output);
  assert.match(first.stdout, new RegExp(`^created ${box.home}$`, "m"));
  assert.match(first.stdout, /^run `penguin list workflows` to see what's available/m);
  assert.match(first.stdout, /`penguin run <workflow>` from a project directory to get started$/m);
  assert.doesNotMatch(first.stdout, /skills in /);
  assert.doesNotMatch(first.stdout, /no \.claude\/skills/);
});
