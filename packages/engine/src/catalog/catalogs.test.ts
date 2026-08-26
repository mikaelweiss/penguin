import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  builtinCatalog,
  homeCatalog,
  projectCatalog,
  roots,
  starterCatalog,
  worktreeCatalogs,
} from "./catalogs.ts";

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

/** A main checkout with a real .git directory, the anchor every worktree points back to. */
function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-repo-"));
  temps.push(dir);
  fs.mkdirSync(path.join(dir, "main", ".git", "worktrees"), { recursive: true });
  return dir;
}

/** What `git worktree add` writes: the pair of files that link a checkout to its repository. */
function checkout(repo: string, name: string): string {
  const dir = path.join(repo, name);
  const entry = path.join(repo, "main", ".git", "worktrees", name);
  fs.mkdirSync(entry, { recursive: true });
  fs.writeFileSync(path.join(entry, "gitdir"), `${dir}/.git\n`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${entry}\n`);
  return dir;
}

function withCatalog(dir: string): string {
  fs.mkdirSync(path.join(dir, ".penguin"), { recursive: true });
  return dir;
}

test("a sibling checkout's catalog lands after the enabled ones and before the builtins", () => {
  const home = tempHome();
  const team = path.join(home, "team");
  fs.mkdirSync(team, { recursive: true });
  fs.writeFileSync(path.join(home, "catalogs"), "team\n");
  const repo = tempRepo();
  const main = withCatalog(path.join(repo, "main"));
  const branch = withCatalog(checkout(repo, "feature"));
  const list = roots(branch);
  expect(list[0]).toEqual(projectCatalog(branch));
  expect(list[1]).toEqual(homeCatalog());
  expect(list[2]).toEqual({ dir: team, scope: "catalog" });
  expect(list[3]).toEqual({ dir: path.join(main, ".penguin"), scope: "worktree", worktree: "main" });
  expect(list[4]).toEqual(builtinCatalog());
  expect(list).toHaveLength(5);
});

test("a worktree whose checkout is gone is skipped, not a phantom root", () => {
  const repo = tempRepo();
  const main = withCatalog(path.join(repo, "main"));
  const pruned = checkout(repo, "pruned");
  withCatalog(pruned);
  fs.rmSync(pruned, { recursive: true });
  expect(worktreeCatalogs(main)).toEqual([]);
});

test("a checkout with no .penguin folder is skipped", () => {
  const repo = tempRepo();
  const main = withCatalog(path.join(repo, "main"));
  checkout(repo, "bare-branch");
  expect(worktreeCatalogs(main)).toEqual([]);
});

test("cwd's own catalog is never listed a second time, symlinked path or not", () => {
  const repo = tempRepo();
  const main = withCatalog(path.join(repo, "main"));
  const branch = withCatalog(checkout(repo, "feature"));
  expect(worktreeCatalogs(fs.realpathSync(branch))).toEqual([
    { dir: path.join(main, ".penguin"), scope: "worktree", worktree: "main" },
  ]);
});

test("from inside a worktree the main checkout and a sibling both appear, by path", () => {
  const repo = tempRepo();
  const main = withCatalog(path.join(repo, "main"));
  const alpha = withCatalog(checkout(repo, "alpha"));
  const beta = withCatalog(checkout(repo, "beta"));
  expect(worktreeCatalogs(alpha)).toEqual([
    { dir: path.join(beta, ".penguin"), scope: "worktree", worktree: "beta" },
    { dir: path.join(main, ".penguin"), scope: "worktree", worktree: "main" },
  ]);
});

test("a bare repository has no worktree catalogs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-bare-"));
  temps.push(dir);
  fs.mkdirSync(path.join(dir, "objects"), { recursive: true });
  fs.mkdirSync(path.join(dir, "refs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "HEAD"), "ref: refs/heads/main\n");
  withCatalog(dir);
  expect(worktreeCatalogs(dir)).toEqual([]);
});
