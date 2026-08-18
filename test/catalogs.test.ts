import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { installedIn } from "../src/adapters.ts";
import * as catalogs from "../src/catalogs.ts";
import { searchPathIn } from "../src/skills.ts";
import { foundIn } from "../src/workflows.ts";

const extraAdapter = `import { adapter } from "penguin";

export default adapter({
  role: "clock",
  name: "extra",
  description: "from the extra catalog",
  build: () => ({ now: () => 1 }),
});
`;

function catalogTree(t: TestContext): { project: string; extra: string; homeCatalog: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-catalogs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project", ".penguin");
  const extra = path.join(root, "extra");
  const homeCatalog = path.join(root, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(extra, "adapters"), { recursive: true });
  fs.mkdirSync(path.join(extra, "skills", "penguin-extra"), { recursive: true });
  fs.mkdirSync(homeCatalog, { recursive: true });
  return { project, extra, homeCatalog };
}

test("roots is the project catalog then the home catalog", () => {
  const cwd = "/repo";
  assert.deepEqual(catalogs.roots(cwd), [catalogs.projectCatalog(cwd), catalogs.homeCatalog()]);
  assert.equal(catalogs.forScope(cwd, "local").dir, catalogs.projectCatalog(cwd).dir);
  assert.equal(catalogs.forScope(cwd, "global").dir, catalogs.homeCatalog().dir);
});

test("a third catalog root is scanned for workflows, adapters, and skills", async (t) => {
  const { project, extra, homeCatalog } = catalogTree(t);
  fs.writeFileSync(path.join(project, "local.ts"), "");
  fs.writeFileSync(path.join(extra, "extra.ts"), "");
  fs.writeFileSync(path.join(extra, "local.ts"), "");
  fs.writeFileSync(path.join(homeCatalog, "global.ts"), "");
  fs.mkdirSync(path.join(homeCatalog, "adapters"), { recursive: true });
  fs.writeFileSync(path.join(extra, "adapters", "clock.ts"), extraAdapter);
  fs.writeFileSync(path.join(homeCatalog, "adapters", "clock.ts"), extraAdapter);
  fs.writeFileSync(path.join(extra, "skills", "penguin-extra", "SKILL.md"), "extra craft\n");

  const list = [
    { dir: project, scope: "local" as const },
    { dir: extra, scope: "global" as const },
    { dir: homeCatalog, scope: "global" as const },
  ];

  const workflows = foundIn(list);
  assert.deepEqual(
    workflows.map((entry) => entry.name),
    ["local", "extra", "local", "global"],
  );
  assert.equal(workflows[0]?.file, path.join(project, "local.ts"));

  const extraCatalog = { dir: extra, scope: "global" as const };
  const adapters = await installedIn(list);
  assert.equal(adapters.length, 1);
  assert.equal(adapters[0]?.name, "extra");
  assert.equal(adapters[0]?.file, path.join(catalogs.adaptersDir(extraCatalog), "clock.ts"));

  const skills = searchPathIn(list).map((root) => root.dir);
  assert.equal(skills.includes(catalogs.skillsDir(extraCatalog)), true);
});
