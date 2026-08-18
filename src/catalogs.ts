import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogsFile, home, projectHome, type Scope } from "./paths.ts";

export type Catalog = {
  dir: string;
  scope: Scope;
};

export function projectCatalog(cwd: string): Catalog {
  return { dir: projectHome(cwd), scope: "local" };
}

export function homeCatalog(): Catalog {
  return { dir: home(), scope: "global" };
}

export function starterCatalog(): Catalog {
  return { dir: fileURLToPath(new URL("../examples", import.meta.url)), scope: "global" };
}

/** Project, then home, then catalogs enabled in ~/.penguin/catalogs. Earlier wins. */
export function roots(cwd: string): Catalog[] {
  return [projectCatalog(cwd), homeCatalog(), ...enabled()];
}

/** The writable catalog for a scope. Enabled catalogs are never this. */
export function forScope(cwd: string, scope: Scope): Catalog {
  return scope === "local" ? projectCatalog(cwd) : homeCatalog();
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
    const dir = text === "starter" ? starterCatalog().dir : path.resolve(home(), text);
    if (!fs.existsSync(dir)) continue;
    found.push({ dir, scope: "global" });
  }
  return found;
}
