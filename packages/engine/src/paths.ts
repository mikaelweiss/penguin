import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function home(): string {
  const override = process.env["PENGUIN_HOME"];
  if (override !== undefined && override !== "") return path.resolve(override);
  return path.join(os.homedir(), ".penguin");
}

export function stateRoot(): string {
  const base = process.env["XDG_STATE_HOME"];
  if (base !== undefined && base !== "") return path.join(path.resolve(base), "penguin");
  return path.join(os.homedir(), ".local", "state", "penguin");
}

export function projectHome(cwd: string): string {
  return path.join(cwd, ".penguin");
}

export function runsDir(): string {
  return path.join(stateRoot(), "runs");
}

export function runDir(id: string): string {
  return path.join(runsDir(), id);
}

/** The git project's root, walking up from cwd. A folder outside any repository is its own root. */
export function projectRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    const marker = path.join(dir, ".git");
    if (fs.existsSync(marker)) return rootOf(dir, marker);
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(cwd);
    dir = up;
  }
}

/** A worktree's .git is a file pointing into the main repository's .git; that repository is the root. */
function rootOf(dir: string, marker: string): string {
  if (fs.statSync(marker).isDirectory()) return dir;
  const linked = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(marker, "utf8"))?.[1];
  if (linked === undefined) return dir;
  const resolved = path.resolve(dir, linked);
  const split = resolved.lastIndexOf(`${path.sep}.git${path.sep}`);
  return split === -1 ? dir : resolved.slice(0, split);
}

export function configFile(): string {
  return path.join(home(), "config");
}

export function catalogsFile(): string {
  return path.join(home(), "catalogs");
}
