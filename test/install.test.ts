import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { sandbox } from "./helpers.ts";

test("a fresh install fills the home with the catalog", (t) => {
  const box = sandbox(t);
  fs.rmSync(box.home, { recursive: true });

  const first = box.wa("ps");

  assert.equal(first.code, 0, first.output);
  assert.equal(fs.existsSync(path.join(box.home, "ticket.ts")), true);
  assert.equal(fs.existsSync(path.join(box.home, "skills", "wa-triage", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(box.home, "tsconfig.json")), true);
  assert.equal(fs.readFileSync(path.join(box.home, "agent"), "utf8").trim(), "claude -p");
});

test("a fresh install leaves ticket in the workflow list", (t) => {
  const box = sandbox(t);
  fs.rmSync(box.home, { recursive: true });
  box.wa("ps");

  const listed = box.wa("list", "workflows");

  assert.equal(listed.code, 0, listed.output);
  assert.match(listed.stdout, /^ticket {2}--ticket <text>\n {2}ticket to merged PR:/m);});

test("install on a home that exists copies nothing", (t) => {
  const box = sandbox(t);

  const again = box.wa("install");

  assert.equal(again.code, 0, again.output);
  assert.match(again.stdout, /wa home is/);
  assert.match(again.stdout, /wa list workflows/);
  assert.equal(fs.existsSync(path.join(box.home, "ticket.ts")), false);
});

test("a fresh install prints the two lines and no skills report", (t) => {
  const box = sandbox(t);
  fs.rmSync(box.home, { recursive: true });
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "review it\n");

  const first = box.wa("ps");

  assert.equal(first.code, 0, first.output);
  assert.match(first.stdout, new RegExp(`^created ${box.home}$`, "m"));
  assert.match(first.stdout, /^run `wa list workflows` to see what's available/m);
  assert.match(first.stdout, /`wa run <workflow>` from a project directory to get started$/m);
  assert.doesNotMatch(first.stdout, /skills in /);
  assert.doesNotMatch(first.stdout, /no \.claude\/skills/);
});
