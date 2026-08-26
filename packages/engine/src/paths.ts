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

/** A folder as the filesystem knows it, so two spellings of one place compare equal. */
export function real(dir: string): string {
  return fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);
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

export type WorktreeCheckout = { name: string; dir: string };

/** Every linked worktree the repository at root knows about, by git's own key. */
export function worktreeCheckouts(root: string): WorktreeCheckout[] {
  const gitdir = path.join(root, ".git");
  if (!fs.existsSync(gitdir) || !fs.statSync(gitdir).isDirectory()) return [];
  const dir = path.join(gitdir, "worktrees");
  if (!fs.existsSync(dir)) return [];
  const found: WorktreeCheckout[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "gitdir");
    let linked;
    try {
      linked = fs.readFileSync(file, "utf8").trim();
    } catch {
      continue;
    }
    if (path.basename(linked) !== ".git") continue;
    found.push({ name: entry.name, dir: path.dirname(linked) });
  }
  return found;
}

export function configFile(): string {
  return path.join(home(), "config");
}

export function catalogsFile(): string {
  return path.join(home(), "catalogs");
}
