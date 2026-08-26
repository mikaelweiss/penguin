import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogsFile, home, projectHome, projectRoot, worktreeCheckouts } from "../paths.ts";

export type CatalogScope = "project" | "home" | "starter" | "catalog" | "worktree" | "builtin";

export type Catalog = {
  dir: string;
  scope: CatalogScope;
  /** Which sibling checkout this came from, on a worktree catalog. */
  worktree?: string;
};

export function projectCatalog(cwd: string): Catalog {
  return { dir: projectHome(cwd), scope: "project" };
}

export function homeCatalog(): Catalog {
  return { dir: home(), scope: "home" };
}

export function starterCatalog(): Catalog {
  return { dir: fileURLToPath(new URL("../../examples", import.meta.url)), scope: "starter" };
}

/** The engine's own adapters, always installed last so anything else can shadow them. */
export function builtinCatalog(): Catalog {
  return { dir: fileURLToPath(new URL("..", import.meta.url)), scope: "builtin" };
}

/**
 * The catalogs of every other checkout of cwd's repository, so a definition written on a branch
 * is startable before it merges. The main checkout is listed too; git keeps no entry for it.
 */
export function worktreeCatalogs(cwd: string): Catalog[] {
  const root = projectRoot(cwd);
  const self = fs.existsSync(cwd) ? fs.realpathSync(cwd) : path.resolve(cwd);
  return [{ name: path.basename(root), dir: root }, ...worktreeCheckouts(root)]
    .sort((a, b) => a.dir.localeCompare(b.dir))
    .filter((entry) => fs.existsSync(projectHome(entry.dir)))
    .filter((entry) => fs.realpathSync(entry.dir) !== self)
    .map((entry): Catalog => ({
      dir: projectHome(entry.dir),
      scope: "worktree",
      worktree: entry.name,
    }));
}

/** Project, then home, then enabled catalogs, then sibling checkouts, then builtin. Earlier wins. */
export function roots(cwd: string): Catalog[] {
  return [
    projectCatalog(cwd),
    homeCatalog(),
    ...enabled(),
    ...worktreeCatalogs(cwd),
    builtinCatalog(),
  ];
}

export function workflowsDir(catalog: Catalog): string {
  return path.join(catalog.dir, "workflows");
}

export function adaptersDir(catalog: Catalog): string {
  return path.join(catalog.dir, "adapters");
}

export function skillsDir(catalog: Catalog): string {
  return path.join(catalog.dir, "skills");
}

function enabled(): Catalog[] {
  const file = catalogsFile();
  if (!fs.existsSync(file)) return [];
  const found: Catalog[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("#")) continue;
    const starter = text === "starter";
    const dir = starter ? starterCatalog().dir : path.resolve(home(), text);
    if (!fs.existsSync(dir)) continue;
    found.push({ dir, scope: starter ? "starter" : "catalog" });
  }
  return found;
}
