import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogsFile, home, projectHome } from "../paths.ts";

export type CatalogScope = "project" | "home" | "starter" | "catalog";
export type WritableCatalog = "project" | "home";

export type Catalog = {
  dir: string;
  scope: CatalogScope;
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

/** Project, then home, then catalogs enabled in ~/.penguin/catalogs. Earlier wins. */
export function roots(cwd: string): Catalog[] {
  return [projectCatalog(cwd), homeCatalog(), ...enabled()];
}

/** The catalog install and sync-skills can write. Enabled catalogs are never this. */
export function writableCatalog(cwd: string, which: WritableCatalog): Catalog {
  return which === "project" ? projectCatalog(cwd) : homeCatalog();
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
