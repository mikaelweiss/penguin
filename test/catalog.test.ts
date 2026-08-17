import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installed, renderEnv } from "../src/adapters.ts";
import { type Sandbox, sandbox } from "./helpers.ts";

const examples = fileURLToPath(new URL("../examples", import.meta.url));

function catalogReady(box: Sandbox, result: string): void {
  fs.cpSync(path.join(examples, "skills"), path.join(box.home, "skills"), { recursive: true });
  fs.cpSync(path.join(examples, "adapters"), path.join(box.home, "adapters"), { recursive: true });
  box.setAgent(result);
  box.setDefaults("agent fake");
}

async function gateOf(box: Sandbox, run: string): Promise<string> {
  await box.waitForState(run, "blocked");
  return String(box.lastState(run)?.["detail"]);
}

test("the catalog ticket workflow runs on a fresh install", async (t) => {
  const box = sandbox(t);
  catalogReady(box, '{"actionable":false,"reason":"no repro"}');

  const started = box.wa("run", path.join(examples, "ticket.ts"), "--ticket", "ABC-1", "--background");

  assert.equal(started.code, 0, started.output);
  assert.equal(await gateOf(box, "ticket-1"), "Not actionable: no repro");
  box.send("ticket-1", "ok");
  assert.equal((await box.waitForEnd("ticket-1"))["phase"], "done");
});

function skillsNamedBy(file: string): string[] {
  const source = fs.readFileSync(path.join(examples, file), "utf8");
  return [...source.matchAll(/\.run\("([^"]+)"/g)].map((match) => match[1] ?? "").sort();
}

test("every skill the catalog workflows name ships with them", () => {
  const files = fs
    .readdirSync(examples)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"));
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

test("the catalog task workflow reaches its commit gate", async (t) => {
  const box = sandbox(t);
  catalogReady(box, '{"verdict":"approved","findings":"none"}');

  const started = box.wa("run", path.join(examples, "task.ts"), "--task", "rename the flag", "--background");

  assert.equal(started.code, 0, started.output);
  assert.equal(await gateOf(box, "task-1"), "Commit? (commit / leave)");
  box.send("task-1", "leave");
  assert.equal((await box.waitForEnd("task-1"))["phase"], "done");
});

test("the catalog fix workflow gates when the bug does not reproduce", async (t) => {
  const box = sandbox(t);
  catalogReady(box, '{"reproduced":false,"notes":"the page loads"}');

  const started = box.wa("run", path.join(examples, "fix.ts"), "--bug", "BUG-2", "--background");

  assert.equal(started.code, 0, started.output);
  assert.equal(await gateOf(box, "fix-1"), "Not reproduced: the page loads");
  box.send("fix-1", "ok");
  assert.equal((await box.waitForEnd("fix-1"))["phase"], "done");
});

test("the catalog review workflow gates when the diff command fails", async (t) => {
  const box = sandbox(t);
  catalogReady(box, "none");

  const started = box.wa("run", path.join(examples, "review.ts"), "--pr", "42", "--background");

  assert.equal(started.code, 0, started.output);
  const question = await gateOf(box, "review-1");
  assert.ok(question.startsWith("gh pr diff 42 failed:"), question);
  box.send("review-1", "ok");
  assert.equal((await box.waitForEnd("review-1"))["phase"], "done");
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

test("the catalog adapters and tsconfig are ready to copy", () => {
  for (const name of ["claude", "git", "gh", "terminal"]) {
    assert.ok(fs.existsSync(path.join(examples, "adapters", `${name}.ts`)), name);
  }

  const text = fs.readFileSync(path.join(examples, "tsconfig.json"), "utf8");
  const config = JSON.parse(text.replaceAll(/^\s*\/\/.*$/gm, "")) as {
    compilerOptions: { paths: Record<string, string[]> };
    include: string[];
  };
  assert.ok(config.compilerOptions.paths["wa"]?.[0]?.includes("wa"));
  assert.ok(config.compilerOptions.paths["zod"]?.[0]?.includes("zod"));
  assert.ok(config.include.includes("adapters/*.ts"));
});

test("the checked-in wa-env.d.ts is what wa writes for the catalog", async () => {
  const prior = process.env["WA_HOME"];
  process.env["WA_HOME"] = examples;
  try {
    const list = await installed(examples);
    assert.equal(
      renderEnv(examples, list),
      fs.readFileSync(path.join(examples, "wa-env.d.ts"), "utf8"),
    );
  } finally {
    if (prior === undefined) delete process.env["WA_HOME"];
    else process.env["WA_HOME"] = prior;
  }
});

test("a workflow loads inside a repo whose package.json has no type field", (t) => {
  const box = sandbox(t);
  box.withShell();
  fs.writeFileSync(path.join(box.project, "package.json"), '{"name":"repo"}\n');
  box.write(
    "w.ts",
    `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({ tag: z.string() }),
  async run({ params, shell }) {
    await shell.run(\`sh -c 'echo \${params.tag} >> out.txt'\`);
  },
});
`,
  );

  const done = box.wa("run", "./w.ts", "--tag", "loaded");

  assert.equal(done.code, 0, done.output);
  assert.deepEqual(box.lines("out.txt"), ["loaded"]);
});
