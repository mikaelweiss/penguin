import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pick, type AdapterFound } from "./adapters.ts";

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
