import fs from "node:fs";
import path from "node:path";
import * as catalogs from "./catalogs.ts";
import { load } from "./loader.ts";
import { usage } from "./params.ts";

export type Details = { description: string; params: string[] };
export type WorkflowFound = { name: string; scope: catalogs.CatalogScope; file: string } & Details;

export function found(cwd: string): Omit<WorkflowFound, keyof Details>[] {
  return foundIn(catalogs.roots(cwd));
}

export function foundIn(list: catalogs.Catalog[]): Omit<WorkflowFound, keyof Details>[] {
  return list.flatMap((catalog) => scan(catalogs.workflowsDir(catalog), catalog.scope));
}

export async function listed(cwd: string): Promise<WorkflowFound[]> {
  return Promise.all(
    found(cwd).map(async (entry) => ({ ...entry, ...(await detailsOf(entry.file)) })),
  );
}

export function locate(name: string, cwd: string): string | undefined {
  return found(cwd).find((entry) => entry.name === name)?.file;
}

export function searchedWorkflows(cwd: string): string[] {
  return catalogs.roots(cwd).map(catalogs.workflowsDir);
}

/** One line per workflow to choose from. A name held by both scopes says which scope it is. */
export function choices(list: WorkflowFound[]): { label: string; note?: string }[] {
  return list.map((entry) => {
    const twice = list.some((other) => other !== entry && other.name === entry.name);
    const label = twice ? `${entry.name} (${entry.scope})` : entry.name;
    const note = entry.description.split("\n")[0] ?? "";
    return note === "" ? { label } : { label, note };
  });
}

async function detailsOf(file: string): Promise<Details> {
  try {
    const definition = await load(file);
    return { description: definition.description.trim(), params: usage(definition.params) };
  } catch {
    return { description: "", params: [] };
  }
}

function scan(dir: string, scope: catalogs.CatalogScope): Omit<WorkflowFound, keyof Details>[] {
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
