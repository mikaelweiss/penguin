import fs from "node:fs";
import path from "node:path";
import type { Adapter } from "../core/adapter.ts";
import { PenguinError } from "../core/errors.ts";
import { defaultsFile } from "../paths.ts";
import * as catalogs from "./catalogs.ts";
import { importDefault } from "./loader.ts";

export type AdapterFound = {
  role: string;
  name: string;
  description: string;
  scope: catalogs.CatalogScope;
  file: string;
  definition: Adapter;
};

export async function installed(cwd: string): Promise<AdapterFound[]> {
  return installedIn(catalogs.roots(cwd));
}

export async function installedIn(list: catalogs.Catalog[]): Promise<AdapterFound[]> {
  const seen = new Set<string>();
  const found: AdapterFound[] = [];
  for (const catalog of list) {
    for (const entry of await scan(catalogs.adaptersDir(catalog), catalog.scope)) {
      const key = `${entry.role}\n${entry.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(entry);
    }
  }
  return found;
}

export function searchedAdapters(cwd: string): string[] {
  return catalogs.roots(cwd).map(catalogs.adaptersDir);
}

export async function loadAdapter(file: string): Promise<Adapter> {
  const definition = (await importDefault(file)) as Adapter | undefined;
  if (
    definition === undefined ||
    typeof definition !== "object" ||
    typeof definition.role !== "string" ||
    typeof definition.name !== "string" ||
    typeof definition.description !== "string" ||
    typeof definition.build !== "function"
  ) {
    throw new PenguinError(`${file} does not default-export an adapter`);
  }
  return definition;
}

/** The implementation the user chose per role, from ~/.penguin/defaults: one "role name" per line. */
export function defaults(): Map<string, string> {
  const file = defaultsFile();
  const map = new Map<string, string>();
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("#")) continue;
    const [role, name] = text.split(/\s+/);
    if (role !== undefined && name !== undefined) map.set(role, name);
  }
  return map;
}

export type Picked = { found: AdapterFound } | { missing: string } | { conflict: string };

export function pick(list: AdapterFound[], role: string, name?: string): Picked {
  const implementations = list.filter((entry) => entry.role === role);
  const chosen = defaults().get(role);
  const wanted = name ?? chosen;
  if (wanted !== undefined) {
    const found = implementations.find((entry) => entry.name === wanted);
    if (found !== undefined) return { found };
    if (implementations.length === 0) {
      return { missing: `no ${role} adapter is installed` };
    }
    const names = implementations.map((entry) => entry.name).join(", ");
    const fix = name === undefined ? ` Edit ${defaultsFile()} to choose one.` : "";
    return { missing: `no ${role} adapter named ${wanted}. Installed: ${names}.${fix}` };
  }
  const first = implementations[0];
  if (first === undefined) {
    return { missing: `no ${role} adapter is installed` };
  }
  if (implementations.length > 1) {
    const names = implementations.map((entry) => entry.name).join(", ");
    return {
      conflict: `${implementations.length} ${role} adapters are installed (${names}). Write "${role} <name>" to ${defaultsFile()} to choose one.`,
    };
  }
  return { found: first };
}

async function scan(dir: string, scope: catalogs.CatalogScope): Promise<AdapterFound[]> {
  if (!fs.existsSync(dir)) return [];
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .filter((entry) => entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
    .map((entry) => entry.name)
    .sort();
  const found: AdapterFound[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const definition = await loadAdapter(file);
    found.push({
      role: definition.role,
      name: definition.name,
      description: definition.description,
      scope,
      file,
      definition,
    });
  }
  return found;
}
