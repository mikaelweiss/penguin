import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Catalog } from "./catalogs.ts";
import { readSkill, skillsIn } from "./skills.ts";

let temps: string[] = [];

afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps = [];
});

function catalogWith(skills: Record<string, string>, scope: Catalog["scope"] = "project"): Catalog {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-skills-"));
  temps.push(dir);
  for (const [name, content] of Object.entries(skills)) {
    fs.mkdirSync(path.join(dir, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", name, "SKILL.md"), content);
  }
  return { dir, scope };
}

function skillMd(name: string, description = "does a thing. Use for tests."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# Steps\n\nDo the thing.\n`;
}

test("scans catalogs in order, earlier wins on a shared name", () => {
  const first = catalogWith({ greet: skillMd("greet", "the project one") });
  const second = catalogWith({ greet: skillMd("greet", "the home one"), other: skillMd("other") }, "home");
  const found = skillsIn([first, second]);
  expect(found.map((entry) => entry.name)).toEqual(["greet", "other"]);
  expect(found[0]?.description).toBe("the project one");
  expect(found[0]?.scope).toBe("project");
});

test("readSkill returns the body without the frontmatter", () => {
  const catalog = catalogWith({ greet: skillMd("greet") });
  const skill = readSkill(path.join(catalog.dir, "skills", "greet"));
  expect(skill.name).toBe("greet");
  expect(skill.text).toBe("# Steps\n\nDo the thing.");
});

test("metadata entries do not shadow the top-level fields", () => {
  const catalog = catalogWith({
    greet: `---\nname: greet\ndescription: greets\nmetadata:\n  name: shadow\n---\n\nBody.\n`,
  });
  const skill = readSkill(path.join(catalog.dir, "skills", "greet"));
  expect(skill.name).toBe("greet");
});

test("a name that differs from its folder refuses to load", () => {
  const catalog = catalogWith({ greet: skillMd("other-name") });
  expect(() => skillsIn([catalog])).toThrow(/names other-name but its folder is greet/);
});

test("a SKILL.md without frontmatter refuses to load", () => {
  const catalog = catalogWith({ greet: "# Just markdown\n" });
  expect(() => skillsIn([catalog])).toThrow(/no frontmatter/);
});

test("a skill folder without a SKILL.md refuses to load", () => {
  const catalog = catalogWith({});
  fs.mkdirSync(path.join(catalog.dir, "skills", "empty"), { recursive: true });
  expect(() => skillsIn([catalog])).toThrow(/no SKILL.md/);
});

test("a worktree skill with a name nothing else supplies installs", () => {
  const project = catalogWith({ greet: skillMd("greet") });
  const branch = catalogWith({ ship: skillMd("ship") }, "worktree");
  expect(skillsIn([project, branch]).map((entry) => entry.name)).toEqual(["greet", "ship"]);
});

test("a worktree skill never shadows a name a non-worktree catalog supplies", () => {
  const branch = catalogWith({ greet: skillMd("greet", "the branch one") }, "worktree");
  const builtin = catalogWith({ greet: skillMd("greet", "the builtin one") }, "builtin");
  const found = skillsIn([branch, builtin]);
  expect(found).toHaveLength(1);
  expect(found[0]?.description).toBe("the builtin one");
});

test("a branch's half-written skill is skipped, never fatal for the project", () => {
  const project = catalogWith({ greet: skillMd("greet") });
  const branch = catalogWith({ ship: skillMd("ship") }, "worktree");
  fs.mkdirSync(path.join(branch.dir, "skills", "half"), { recursive: true });
  expect(skillsIn([project, branch]).map((entry) => entry.name)).toEqual(["greet", "ship"]);
});
