import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedIn, pick, type AdapterFound } from "./adapters.ts";
import type { Catalog } from "./catalogs.ts";

function entry(role: string, name: string): AdapterFound {
  return {
    role,
    name,
    description: "a test adapter",
    scope: "project",
    file: `${role}/${name}.ts`,
    definition: { role, name, description: "a test adapter", build: () => ({}) },
  };
}

let temps: string[] = [];

afterEach(() => {
  delete process.env["PENGUIN_HOME"];
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps = [];
});

test("the only implementation of a role wins", () => {
  const picked = pick([entry("vcs", "git")], "vcs");
  expect("found" in picked && picked.found.name).toBe("git");
});

test("two implementations with no choice recorded conflict", () => {
  const picked = pick([entry("vcs", "git"), entry("vcs", "jj")], "vcs");
  expect("conflict" in picked).toBe(true);
  if ("conflict" in picked) {
    expect(picked.conflict).toContain("git");
    expect(picked.conflict).toContain("jj");
  }
});

test("an explicit name picks among many", () => {
  const picked = pick([entry("vcs", "git"), entry("vcs", "jj")], "vcs", "jj");
  expect("found" in picked && picked.found.name).toBe("jj");
});

test("a name that is not installed is missing, and the installed ones are named", () => {
  const picked = pick([entry("vcs", "git")], "vcs", "jj");
  expect("missing" in picked).toBe(true);
  if ("missing" in picked) expect(picked.missing).toContain("git");
});

test("a role with nothing installed is missing", () => {
  expect("missing" in pick([], "vcs")).toBe(true);
});

test("the config file chooses a role's implementation", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-home-"));
  temps.push(home);
  process.env["PENGUIN_HOME"] = home;
  fs.writeFileSync(path.join(home, "config"), "# picks\nvcs jj\n");
  const picked = pick([entry("vcs", "git"), entry("vcs", "jj")], "vcs");
  expect("found" in picked && picked.found.name).toBe("jj");
});

test("a builtin is a fallback: one installed implementation shadows it", () => {
  const builtin: AdapterFound = { ...entry("view", "files"), scope: "builtin" };
  const alone = pick([builtin], "view");
  expect("found" in alone && alone.found.name).toBe("files");
  const shadowed = pick([builtin, entry("view", "web")], "view");
  expect("found" in shadowed && shadowed.found.name).toBe("web");
});

function adapterFile(role: string, name: string): string {
  return `import { adapter } from "penguin";
export default adapter({
  role: "${role}",
  name: "${name}",
  description: "a test adapter",
  build: () => ({}),
});
`;
}

function catalogWith(
  scope: Catalog["scope"],
  role: string,
  name: string,
  worktree?: string,
): Catalog {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-adapters-"));
  temps.push(dir);
  fs.mkdirSync(path.join(dir, "adapters"), { recursive: true });
  fs.writeFileSync(path.join(dir, "adapters", `${name}.ts`), adapterFile(role, name));
  return worktree === undefined ? { dir, scope } : { dir, scope, worktree };
}

test("a worktree adapter for a role the project already supplies is dropped", async () => {
  const found = await installedIn([
    catalogWith("project", "vcs", "git"),
    catalogWith("worktree", "vcs", "jj", "feature"),
  ]);
  expect(found.map((entry) => entry.name)).toEqual(["git"]);
});

test("a worktree adapter for a role only the builtin supplies is dropped", async () => {
  const found = await installedIn([
    catalogWith("worktree", "view", "web", "feature"),
    catalogWith("builtin", "view", "files-view"),
  ]);
  expect(found.map((entry) => entry.name)).toEqual(["files-view"]);
});

test("two worktrees claiming one new role drop both, rather than conflicting every run", async () => {
  const found = await installedIn([
    catalogWith("worktree", "fmt", "black", "alpha"),
    catalogWith("worktree", "fmt", "ruff", "beta"),
  ]);
  expect(found).toEqual([]);
});

test("a role only one worktree supplies installs from the branch", async () => {
  const found = await installedIn([
    catalogWith("project", "vcs", "git"),
    catalogWith("worktree", "fmt", "ruff", "feature"),
  ]);
  expect(found.map((entry) => entry.name)).toEqual(["git", "ruff"]);
  expect(found[1]?.scope).toBe("worktree");
});
