import path from "node:path";
import { home, projectHome, type Scope } from "./paths.ts";

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

/** Catalog directories to scan, earlier first. Today the project then the home. */
export function roots(cwd: string): Catalog[] {
  return [projectCatalog(cwd), homeCatalog()];
}

export function forScope(cwd: string, scope: Scope): Catalog {
  return roots(cwd).find((catalog) => catalog.scope === scope) ?? homeCatalog();
}

export function adaptersDir(catalog: Catalog): string {
  return path.join(catalog.dir, "adapters");
}

export function skillsDir(catalog: Catalog): string {
  return path.join(catalog.dir, "skills");
}
