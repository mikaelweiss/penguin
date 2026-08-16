import fs from "node:fs";
import path from "node:path";
import { home, projectHome, type Scope, short } from "./paths.ts";
import { table } from "./table.ts";

export type Found = { name: string; scope: Scope; file: string };

export function found(cwd: string): Found[] {
  return [...scan(projectHome(cwd), "local"), ...scan(home(), "global")];
}

export function locate(name: string, cwd: string): string | undefined {
  return found(cwd).find((entry) => entry.name === name)?.file;
}

export function searched(cwd: string): string[] {
  return [projectHome(cwd), home()];
}

export function render(list: Found[]): string {
  const rows = [["WORKFLOW", "SCOPE", "FILE"]];
  for (const entry of list) rows.push([entry.name, entry.scope, short(entry.file)]);
  return table(rows);
}

function scan(dir: string, scope: Scope): Found[] {
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
