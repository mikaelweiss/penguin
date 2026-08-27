import fs from "node:fs";
import path from "node:path";
import { readConfig } from "../config.ts";
import type { Adapter } from "../core/adapter.ts";
import { PenguinError } from "../core/errors.ts";
import { configFile } from "../paths.ts";
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
  const all: AdapterFound[] = [];
  for (const catalog of list) {
    all.push(...(await scan(catalogs.adaptersDir(catalog), catalog.scope)));
  }
  const chosen = readConfig();
  const seen = new Set<string>();
  const found: AdapterFound[] = [];
  for (const entry of all) {
    if (entry.scope === "worktree" && !askedFor(all, entry, chosen)) continue;
    const key = `${entry.role}\n${entry.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(entry);
  }
  return found;
}

/**
 * Every installed role is built before a workflow's own code runs, and build() is handed the
 * keychain and the shell, so an adapter sitting in a branch checkout stays inert until the config
 * names it. Even then a branch may only add a role, never take one over: two branches claiming one
 * role would conflict every run in the project, and one shadowing the builtin view would change
 * what already resolves.
 */
function askedFor(all: AdapterFound[], entry: AdapterFound, chosen: Map<string, string>): boolean {
  if (chosen.get(entry.role) !== entry.name) return false;
  return all.filter((other) => other.role === entry.role).length === 1;
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

export type Picked = { found: AdapterFound } | { missing: string } | { conflict: string };

export function pick(list: AdapterFound[], role: string, name?: string): Picked {
  const implementations = list.filter((entry) => entry.role === role);
  const chosen = readConfig().get(role);
  const wanted = name ?? chosen;
  if (wanted !== undefined) {
    const found = implementations.find((entry) => entry.name === wanted);
    if (found !== undefined) return { found };
    if (implementations.length === 0) {
      return { missing: `no ${role} adapter is installed` };
    }
    const names = implementations.map((entry) => entry.name).join(", ");
    const fix = name === undefined ? ` Edit ${configFile()} to choose one.` : "";
    return { missing: `no ${role} adapter named ${wanted}. Installed: ${names}.${fix}` };
  }
  // The catalogs are a search path: the nearest one claiming the role wins, so a project's
  // adapter shadows a starter's the way any installed one already shadowed the builtin. Two
  // names at one distance is the ambiguity nobody can rank, so that still asks for a line.
  const nearest = Math.min(...implementations.map((entry) => catalogs.nearness(entry.scope)));
  const candidates = implementations.filter(
    (entry) => catalogs.nearness(entry.scope) === nearest,
  );
  const first = candidates[0];
  if (first === undefined) {
    return { missing: `no ${role} adapter is installed` };
  }
  if (candidates.length > 1) {
    const names = candidates.map((entry) => entry.name).join(", ");
    return {
      conflict: `${candidates.length} ${role} adapters are installed (${names}). Write "${role} <name>" to ${configFile()} to choose one.`,
    };
  }
  return { found: first };
}

async function scan(dir: string, scope: catalogs.CatalogScope): Promise<AdapterFound[]> {
  if (!fs.existsSync(dir)) return [];
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .filter((entry) => entry.name.endsWith(".ts"))
    .filter((entry) => !/\.(d|test)\.ts$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const found: AdapterFound[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let definition;
    try {
      definition = await loadAdapter(file);
    } catch (error) {
      // A branch is free to be half written. Its broken file must not fail every run in the project.
      if (scope !== "worktree") throw error;
      continue;
    }
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
