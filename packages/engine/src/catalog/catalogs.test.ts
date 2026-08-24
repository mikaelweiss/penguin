import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { builtinCatalog, homeCatalog, projectCatalog, roots, starterCatalog } from "./catalogs.ts";

let temps: string[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-home-"));
  process.env["PENGUIN_HOME"] = dir;
  temps.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env["PENGUIN_HOME"];
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps = [];
});

test("scans project first, then home, then enabled catalogs, earlier wins", () => {
  const home = tempHome();
  const team = path.join(home, "team");
  fs.mkdirSync(team, { recursive: true });
  fs.writeFileSync(path.join(home, "catalogs"), "# shared sets\n\nteam\nstarter\nmissing\n");
  const list = roots("/project");
  expect(list[0]).toEqual(projectCatalog("/project"));
  expect(list[1]).toEqual(homeCatalog());
  expect(list[2]).toEqual({ dir: team, scope: "catalog" });
  expect(list[3]).toEqual(starterCatalog());
  expect(list[4]).toEqual(builtinCatalog());
  expect(list).toHaveLength(5);
});

test("no catalogs file means project, home, and the builtins", () => {
  tempHome();
  expect(roots("/project")).toHaveLength(3);
});
