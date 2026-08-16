import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { sandbox } from "./helpers.ts";

const writes = (text: string, params = "z.object({})") => `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "${text}",
  params: ${params},
  async run({ shell }) {
    await shell.run("sh -c 'echo ${text} >> out.txt'");
  },
});
`;

test("list workflows shows the description under the name", (t) => {
  const box = sandbox(t);
  box.write(".wa/ticket.ts", writes("local"));
  fs.writeFileSync(path.join(box.home, "release.ts"), writes("global"));

  const listed = box.wa("list", "workflows");

  assert.equal(listed.code, 0, listed.output);
  assert.match(listed.stdout, /^ticket\n {2}local$/m);
  assert.match(listed.stdout, /^release\n {2}global$/m);
  assert.doesNotMatch(listed.stdout, /DESCRIPTION/);
  assert.doesNotMatch(listed.stdout, /run one with/);
});

test("list workflows shows the params next to the name", (t) => {
  const box = sandbox(t);
  box.write(
    ".wa/ticket.ts",
    writes(
      "local",
      "z.object({ ticket: z.string(), rounds: z.number().default(3), draft: z.boolean().optional(), mode: z.enum(['fast', 'slow']) })",
    ),
  );

  const listed = box.wa("list", "workflows");

  assert.equal(listed.code, 0, listed.output);
  assert.match(
    listed.stdout,
    /^ticket {2}--ticket <text> \[--rounds <number>\] \[--draft\] --mode <fast\|slow>$/m,
  );
});

test("list workflows wraps a long description and a long param line", (t) => {
  const box = sandbox(t);
  const long = "wraps ".repeat(40).trim();
  const many = Array.from({ length: 12 }, (_, index) => `p${index}: z.string()`).join(", ");
  box.write(".wa/ticket.ts", writes(long, `z.object({ ${many} })`));

  const listed = box.wa("list", "workflows");

  assert.equal(listed.code, 0, listed.output);
  const lines = listed.stdout.split("\n").filter((line) => line !== "");
  assert.ok(lines.length > 3, listed.stdout);
  for (const line of lines) assert.ok(line.length <= 80, `${line.length}: ${line}`);
  for (const line of lines.slice(1)) assert.match(line, /^ {2}\S/);
  assert.equal(listed.stdout.replace(/\s+/g, " ").includes(long), true);
});

test("list workflows --verbose adds scope and file", (t) => {
  const box = sandbox(t);
  box.write(".wa/ticket.ts", writes("local"));
  fs.writeFileSync(path.join(box.home, "release.ts"), writes("global"));

  const listed = box.wa("list", "workflows", "--verbose");

  assert.equal(listed.code, 0, listed.output);
  assert.match(
    listed.stdout,
    new RegExp(`^ticket\\n {2}local\\n {2}local {2}${path.join(box.project, ".wa")}`, "m"),
  );
  assert.match(
    listed.stdout,
    new RegExp(`^release\\n {2}global\\n {2}global {2}${box.home}`, "m"),
  );
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
  box.withShell();
  fs.writeFileSync(path.join(box.home, "release.ts"), writes("global"));

  const done = box.wa("run", "release");

  assert.equal(done.code, 0, done.output);
  assert.match(done.stdout, /^run release-1 started,/m);
  assert.deepEqual(box.lines("out.txt"), ["global"]);
});

test("a project workflow shadows the home workflow of the same name", (t) => {
  const box = sandbox(t);
  box.withShell();
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
  box.withShell();
  box.write("w.ts", writes("path"));

  assert.equal(box.wa("run", "./w.ts").code, 0);

  assert.deepEqual(box.lines("out.txt"), ["path"]);
});
