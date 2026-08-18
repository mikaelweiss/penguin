import fs from "node:fs";
import path from "node:path";
import { blocks } from "./layout.ts";
import { load } from "./loader.ts";
import { usage } from "./params.ts";
import { home, projectHome, type Scope, short } from "./paths.ts";

export type Details = { description: string; params: string[] };
export type Found = { name: string; scope: Scope; file: string } & Details;

export function found(cwd: string): Omit<Found, keyof Details>[] {
  return [...scan(projectHome(cwd), "local"), ...scan(home(), "global")];
}

export async function listed(cwd: string): Promise<Found[]> {
  return Promise.all(
    found(cwd).map(async (entry) => ({ ...entry, ...(await detailsOf(entry.file)) })),
  );
}

export function locate(name: string, cwd: string): string | undefined {
  return found(cwd).find((entry) => entry.name === name)?.file;
}

export function searched(cwd: string): string[] {
  return [projectHome(cwd), home()];
}

export function render(list: Found[], verbose = false): string {
  return blocks(
    list.map((entry) => ({
      name: entry.name,
      tokens: entry.params,
      description: entry.description,
      meta: verbose ? `${entry.scope}  ${short(entry.file)}` : "",
    })),
  );
}

/** One line per workflow to choose from. A name held by both scopes says which scope it is. */
export function choices(list: Found[]): { label: string; note?: string }[] {
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

function scan(dir: string, scope: Scope): Omit<Found, keyof Details>[] {
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
