import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { GateEntry } from "../src/journal.ts";
import { sandbox } from "./helpers.ts";

const examples = fileURLToPath(new URL("../examples", import.meta.url));

test("the catalog ticket workflow runs on a fresh install", (t) => {
  const box = sandbox(t);
  fs.cpSync(path.join(examples, "skills"), path.join(box.home, "skills"), { recursive: true });
  box.setAgent(box.agentCommand('{"actionable":false,"reason":"no repro"}'));

  const parked = box.wa("run", path.join(examples, "ticket.ts"), "--ticket", "ABC-1");

  assert.equal(parked.code, 0, parked.output);
  const gate = box.journal("ticket-1").find((entry): entry is GateEntry => entry.type === "gate");
  assert.equal(gate?.question, "Not actionable: no repro");
});

function skillsNamedBy(file: string): string[] {
  const source = fs.readFileSync(path.join(examples, file), "utf8");
  return [...source.matchAll(/step\.agent\("([^"]+)"/g)].map((match) => match[1] ?? "").sort();
}

test("every skill the catalog workflows name ships with them", () => {
  const files = fs.readdirSync(examples).filter((name) => name.endsWith(".ts"));
  assert.deepEqual(files.sort(), ["fix.ts", "review.ts", "task.ts", "ticket.ts"]);

  assert.deepEqual(skillsNamedBy("ticket.ts"), [
    "wa-address-feedback",
    "wa-implement",
    "wa-plan",
    "wa-review",
    "wa-triage",
  ]);

  for (const file of files) {
    const named = skillsNamedBy(file);
    assert.ok(named.length > 0, `${file} names no skill`);
    for (const skill of named) {
      assert.ok(
        fs.existsSync(path.join(examples, "skills", skill, "SKILL.md")),
        `${skill} is missing`,
      );
    }
  }
});

test("the catalog task workflow reaches its commit gate", (t) => {
  const box = sandbox(t);
  fs.cpSync(path.join(examples, "skills"), path.join(box.home, "skills"), { recursive: true });
  box.setAgent(box.agentCommand('{"verdict":"approved","findings":"none"}'));

  const parked = box.wa("run", path.join(examples, "task.ts"), "--task", "rename the flag");

  assert.equal(parked.code, 0, parked.output);
  const gate = box.journal("task-1").find((entry): entry is GateEntry => entry.type === "gate");
  assert.equal(gate?.question, "Commit? (commit / leave)");
});

test("the catalog fix workflow parks when the bug does not reproduce", (t) => {
  const box = sandbox(t);
  fs.cpSync(path.join(examples, "skills"), path.join(box.home, "skills"), { recursive: true });
  box.setAgent(box.agentCommand('{"reproduced":false,"notes":"the page loads"}'));

  const parked = box.wa("run", path.join(examples, "fix.ts"), "--bug", "BUG-2");

  assert.equal(parked.code, 0, parked.output);
  const gate = box.journal("fix-1").find((entry): entry is GateEntry => entry.type === "gate");
  assert.equal(gate?.question, "Not reproduced: the page loads");
});

test("the catalog review workflow parks when the diff command fails", (t) => {
  const box = sandbox(t);

  const parked = box.wa("run", path.join(examples, "review.ts"), "--pr", "42");

  assert.equal(parked.code, 0, parked.output);
  const gate = box.journal("review-1").find((entry): entry is GateEntry => entry.type === "gate");
  assert.ok(gate?.question.startsWith("gh pr diff 42 failed:"), gate?.question);
});

test("every catalog skill follows the SKILL.md format", () => {
  const dir = path.join(examples, "skills");
  const names = fs.readdirSync(dir);
  assert.ok(names.length > 0);

  for (const name of names) {
    assert.match(name, /^wa-[a-z0-9]+(-[a-z0-9]+)*$/, `${name} is not a wa- prefixed skill name`);
    assert.ok(name.length <= 64, `${name} is longer than 64 characters`);

    const text = fs.readFileSync(path.join(dir, name, "SKILL.md"), "utf8");
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(front !== null, `${name} has no frontmatter`);

    const fields = new Map(
      (front[1] ?? "")
        .split("\n")
        .map((line) => line.split(/:(.*)/s))
        .map(([key, value]) => [key ?? "", (value ?? "").trim()]),
    );
    assert.deepEqual([...fields.keys()].sort(), ["description", "name"], `${name} has extra keys`);
    assert.equal(fields.get("name"), name, `the name of ${name} is not the directory name`);
    const description = fields.get("description") ?? "";
    assert.ok(description.length > 0 && description.length <= 1024);
    assert.match(description, /Use (when|after|before)/, `${name} says nothing about when to use it`);
  }
});

test("the catalog agent line and tsconfig are ready to copy", () => {
  assert.equal(fs.readFileSync(path.join(examples, "agent"), "utf8").trim(), "claude -p");

  const text = fs.readFileSync(path.join(examples, "tsconfig.json"), "utf8");
  const config = JSON.parse(text.replaceAll(/^\s*\/\/.*$/gm, "")) as {
    compilerOptions: { paths: Record<string, string[]> };
  };
  assert.ok(config.compilerOptions.paths["wa"]?.[0]?.includes("wa"));
  assert.ok(config.compilerOptions.paths["zod"]?.[0]?.includes("zod"));
});

test("a workflow loads inside a repo whose package.json has no type field", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(path.join(box.project, "package.json"), '{"name":"repo"}\n');
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({ tag: z.string() }),
  async run({ params, step }) {
    await step.command(\`sh -c 'echo \${params.tag} >> out.txt'\`);
  },
});
`,
  );

  const done = box.wa("run", "./w.ts", "--tag", "loaded");

  assert.equal(done.code, 0, done.output);
  assert.deepEqual(box.lines("out.txt"), ["loaded"]);
});
