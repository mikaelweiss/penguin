import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Catalog } from "./catalogs.ts";
import { load } from "./loader.ts";

let temps: string[] = [];

function tempFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-load-"));
  temps.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

/** A catalog on disk, its workflows written by name. */
function tempCatalog(workflows: Record<string, string>): Catalog {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-catalog-"));
  temps.push(dir);
  fs.mkdirSync(path.join(dir, "workflows"));
  for (const [name, content] of Object.entries(workflows)) {
    fs.writeFileSync(path.join(dir, "workflows", `${name}.ts`), content);
  }
  return { dir, scope: "project" };
}

/** A workflow named by its description, so what a composed import resolved to is readable. */
function saying(what: string): string {
  return `import { workflow } from "penguin";
import { z } from "zod";
export default workflow({
  description: "${what}",
  params: z.object({}),
  async run() {
    return null;
  },
});
`;
}

/** A workflow that composes another catalog's, and says which one it got. */
function composing(name: string): string {
  return `import { workflow } from "penguin";
import { z } from "zod";
import held from "penguin:${name}";
export default workflow({
  description: \`composes \${held.description}\`,
  params: z.object({}),
  async run() {
    return null;
  },
});
`;
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

test("a workflow composes another catalog's workflow by name", async () => {
  const held = tempCatalog({ helper: saying("the helper") });
  const caller = tempCatalog({ caller: composing("helper") });
  const file = path.join(caller.dir, "workflows", "caller.ts");
  const definition = await load(file, [caller, held]);
  expect(definition.description).toBe("composes the helper");
});

test("a composed import takes the nearest catalog holding the name", async () => {
  const far = tempCatalog({ helper: saying("the far helper") });
  const near = tempCatalog({ helper: saying("the near helper"), caller: composing("helper") });
  const file = path.join(near.dir, "workflows", "caller.ts");
  const definition = await load(file, [near, far]);
  expect(definition.description).toBe("composes the near helper");
});

test("a composed import naming nothing installed says what is", async () => {
  const catalog = tempCatalog({ caller: composing("missing") });
  const file = path.join(catalog.dir, "workflows", "caller.ts");
  await expect(load(file, [catalog])).rejects.toThrow(
    "no workflow named missing. Installed: caller",
  );
});
