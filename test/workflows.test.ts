import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { sandbox } from "./helpers.ts";

const writes = (text: string) => `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "${text}",
  params: z.object({}),
  async run({ step }) {
    await step.command("sh -c 'echo ${text} >> out.txt'");
  },
});
`;

test("list workflows shows name and description", (t) => {
  const box = sandbox(t);
  box.write(".wa/ticket.ts", writes("local"));
  fs.writeFileSync(path.join(box.home, "release.ts"), writes("global"));

  const listed = box.wa("list", "workflows");

  assert.equal(listed.code, 0, listed.output);
  assert.match(listed.stdout, /^WORKFLOW\s+DESCRIPTION$/m);
  assert.match(listed.stdout, /^ticket\s+local$/m);
  assert.match(listed.stdout, /^release\s+global$/m);
  assert.doesNotMatch(listed.stdout, /SCOPE/);
  assert.doesNotMatch(listed.stdout, /run one with/);
});

test("list workflows --verbose adds scope and file", (t) => {
  const box = sandbox(t);
  box.write(".wa/ticket.ts", writes("local"));
  fs.writeFileSync(path.join(box.home, "release.ts"), writes("global"));

  const listed = box.wa("list", "workflows", "--verbose");

  assert.equal(listed.code, 0, listed.output);
  assert.match(listed.stdout, /^WORKFLOW\s+DESCRIPTION\s+SCOPE\s+FILE$/m);
  assert.match(listed.stdout, new RegExp(`^ticket\\s+local\\s+local\\s+${path.join(box.project, ".wa")}`, "m"));
  assert.match(listed.stdout, new RegExp(`^release\\s+global\\s+global\\s+${box.home}`, "m"));
});

test("wa with no command prints the usage", (t) => {
  const box = sandbox(t);
  box.write(".wa/ticket.ts", writes("local"));

  const listed = box.wa();

  assert.equal(listed.code, 0, listed.output);
  assert.match(listed.stdout, /usage:/);
  assert.doesNotMatch(listed.stdout, /^ticket/m);
});

test("wa run with no workflow lists them instead of failing", (t) => {
  const box = sandbox(t);
  box.write(".wa/ticket.ts", writes("local"));

  const listed = box.wa("run");

  assert.equal(listed.code, 0, listed.output);
  assert.match(listed.stdout, /^ticket\s+local$/m);
  assert.match(listed.stdout, /run one with: wa run <workflow>/);
});

test("wa list workflows with no file says where to put one", (t) => {
  const box = sandbox(t);

  const empty = box.wa("list", "workflows");

  assert.equal(empty.code, 0);
  assert.match(empty.stdout, new RegExp(`no workflow file in ${path.join(box.project, ".wa")}`));
  assert.match(empty.stdout, new RegExp(box.home));
});

test("the first bare wa stops after the install output", (t) => {
  const box = sandbox(t);
  fs.rmSync(box.home, { recursive: true });

  const first = box.wa();

  assert.equal(first.code, 0);
  assert.match(first.stdout, /created/);
  assert.match(first.stdout, /wa list workflows/);
  assert.doesNotMatch(first.stdout, /no workflow file/);
  assert.doesNotMatch(first.stdout, /usage:/);
});

test("wa run takes a workflow name", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(path.join(box.home, "release.ts"), writes("global"));

  const done = box.wa("run", "release");

  assert.equal(done.code, 0, done.output);
  assert.match(done.stdout, /^run release-1 started,/m);
  assert.deepEqual(box.lines("out.txt"), ["global"]);
});

test("a project workflow shadows the home workflow of the same name", (t) => {
  const box = sandbox(t);
  box.write(".wa/ticket.ts", writes("local"));
  fs.writeFileSync(path.join(box.home, "ticket.ts"), writes("global"));

  assert.equal(box.wa("run", "ticket").code, 0);

  assert.deepEqual(box.lines("out.txt"), ["local"]);
});

test("a name that matches nothing names both places", (t) => {
  const box = sandbox(t);

  const failed = box.wa("run", "nothing");

  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /no workflow file at .*nothing/);
  assert.match(failed.stderr, /no workflow named nothing in/);
});

test("wa run still takes a path", (t) => {
  const box = sandbox(t);
  box.write("w.ts", writes("path"));

  assert.equal(box.wa("run", "./w.ts").code, 0);

  assert.deepEqual(box.lines("out.txt"), ["path"]);
});
