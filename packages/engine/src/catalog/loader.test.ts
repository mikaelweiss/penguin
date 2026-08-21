import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load } from "./loader.ts";

let temps: string[] = [];

function tempFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-load-"));
  temps.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps = [];
});

test("loads a workflow file that imports penguin and zod bare", async () => {
  const file = tempFile(
    "good.ts",
    `import { workflow } from "penguin";
import { z } from "zod";
export default workflow({
  description: "a test workflow",
  params: z.object({}),
  async run() {
    return "ran";
  },
});
`,
  );
  const definition = await load(file);
  expect(definition.description).toBe("a test workflow");
});

test("a file whose default export is not a workflow is refused by name", async () => {
  const file = tempFile("plain.ts", `export default { description: "x" };\n`);
  await expect(load(file)).rejects.toThrow("does not default-export a workflow");
});

test("a workflow without a description is refused", async () => {
  const file = tempFile(
    "blank.ts",
    `export default { description: " ", params: { parse: () => ({}) }, run: async () => null };\n`,
  );
  await expect(load(file)).rejects.toThrow("has no description");
});
