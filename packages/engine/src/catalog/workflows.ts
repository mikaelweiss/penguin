import fs from "node:fs";
import path from "node:path";
import * as catalogs from "./catalogs.ts";

export type WorkflowFound = { name: string; scope: catalogs.CatalogScope; file: string };

export function found(cwd: string): WorkflowFound[] {
  return catalogs.roots(cwd).flatMap((catalog) => scan(catalogs.workflowsDir(catalog), catalog.scope));
}

export function locate(name: string, cwd: string): string | undefined {
  return found(cwd).find((entry) => entry.name === name)?.file;
}

export function searchedWorkflows(cwd: string): string[] {
  return catalogs.roots(cwd).map(catalogs.workflowsDir);
}

function scan(dir: string, scope: catalogs.CatalogScope): WorkflowFound[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .filter((entry) => entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name: name.replace(/\.ts$/, ""),
      scope,
      file: path.join(dir, name),
    }));
}
