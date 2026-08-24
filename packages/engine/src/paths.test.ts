import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "./paths.ts";

let temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-root-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps = [];
});

test("walks up to the folder holding .git", () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, ".git"));
  fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
  expect(projectRoot(path.join(dir, "a", "b"))).toBe(dir);
});

test("a worktree's .git file points home to the main project", () => {
  const dir = tempDir();
  const main = path.join(dir, "main");
  const worktree = path.join(dir, "wt");
  fs.mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${main}/.git/worktrees/wt\n`);
  expect(projectRoot(worktree)).toBe(main);
});

test("a folder outside any repository is its own root", () => {
  const dir = tempDir();
  expect(projectRoot(dir)).toBe(dir);
});
