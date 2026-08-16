import fs from "node:fs";
import path from "node:path";
import { load } from "./loader.ts";
import { home, projectHome, type Scope, short } from "./paths.ts";
import { table } from "./table.ts";

export type Found = { name: string; scope: Scope; file: string; description: string };

export function found(cwd: string): Omit<Found, "description">[] {
  return [...scan(projectHome(cwd), "local"), ...scan(home(), "global")];
}

export async function listed(cwd: string): Promise<Found[]> {
  return Promise.all(
    found(cwd).map(async (entry) => ({
      ...entry,
      description: await descriptionOf(entry.file),
    })),
  );
}

export function locate(name: string, cwd: string): string | undefined {
  return found(cwd).find((entry) => entry.name === name)?.file;
}

export function searched(cwd: string): string[] {
  return [projectHome(cwd), home()];
}

export function render(list: Found[], verbose = false): string {
  const rows = verbose
    ? [["WORKFLOW", "DESCRIPTION", "SCOPE", "FILE"]]
    : [["WORKFLOW", "DESCRIPTION"]];
  for (const entry of list) {
    rows.push(
      verbose
        ? [entry.name, entry.description, entry.scope, short(entry.file)]
        : [entry.name, entry.description],
    );
  }
  return table(rows);
}

async function descriptionOf(file: string): Promise<string> {
  try {
    return (await load(file)).description.trim();
  } catch {
    return "";
  }
}

function scan(dir: string, scope: Scope): Omit<Found, "description">[] {
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
