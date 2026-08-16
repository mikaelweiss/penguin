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
  box.setAgent(box.agentCommand('{"actionable":false,"reason":"no repro"}'));

  const parked = box.wa("run", path.join(examples, "ticket.ts"), "--ticket", "ABC-1");

  assert.equal(parked.code, 0);
  const gate = box.journal("ticket-1").find((entry): entry is GateEntry => entry.type === "gate");
  assert.equal(gate?.question, "Not actionable: no repro");
});

test("every skill the ticket workflow names ships with it", () => {
  const source = fs.readFileSync(path.join(examples, "ticket.ts"), "utf8");
  const named = [...source.matchAll(/step\.agent\("([^"]+)"/g)].map((match) => match[1] ?? "");

  assert.deepEqual(named.sort(), [
    "./skills/address-feedback.md",
    "./skills/implement.md",
    "./skills/plan.md",
    "./skills/review.md",
    "./skills/triage.md",
  ]);
  for (const skill of named) {
    assert.ok(fs.existsSync(path.join(examples, skill)), `${skill} is missing`);
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
