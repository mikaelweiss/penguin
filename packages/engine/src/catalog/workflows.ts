import fs from "node:fs";
import path from "node:path";
import * as catalogs from "./catalogs.ts";

export type WorkflowFound = {
  name: string;
  scope: catalogs.CatalogScope;
  file: string;
  /** Which sibling checkout it was found in, on a worktree workflow. */
  worktree?: string;
};

export function found(cwd: string): WorkflowFound[] {
  return foundIn(catalogs.roots(cwd));
}

export function foundIn(list: catalogs.Catalog[]): WorkflowFound[] {
  return list.flatMap(scan);
}

export function locate(name: string, cwd: string): string | undefined {
  return locateIn(name, catalogs.roots(cwd));
}

/** The file a name resolves to: the nearest catalog holding it, so a farther one is shadowed. */
export function locateIn(name: string, list: catalogs.Catalog[]): string | undefined {
  return foundIn(list).find((entry) => entry.name === name)?.file;
}

export function searchedWorkflows(cwd: string): string[] {
  return catalogs.roots(cwd).map(catalogs.workflowsDir);
}

function scan(catalog: catalogs.Catalog): WorkflowFound[] {
  const dir = catalogs.workflowsDir(catalog);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .filter((entry) => entry.name.endsWith(".ts"))
    .filter((entry) => !/\.(d|test)\.ts$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name: name.replace(/\.ts$/, ""),
      scope: catalog.scope,
      file: path.join(dir, name),
      worktree: catalog.worktree,
    }));
}
