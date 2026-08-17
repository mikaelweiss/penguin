import fs from "node:fs";
import path from "node:path";
import { PenguinError } from "./errors.ts";
import { importDefault } from "./loader.ts";
import { defaultsFile, envFile, home, homeAdapters, projectAdapters, projectHome, type Scope } from "./paths.ts";
import type { Adapter } from "./types.ts";

export type Found = {
  role: string;
  name: string;
  description: string;
  scope: Scope;
  file: string;
  definition: Adapter;
};

export async function installed(cwd: string): Promise<Found[]> {
  const local = await scan(projectAdapters(cwd), "local");
  const global = await scan(homeAdapters(), "global");
  const seen = new Set(local.map((entry) => `${entry.role}\n${entry.name}`));
  return [...local, ...global.filter((entry) => !seen.has(`${entry.role}\n${entry.name}`))];
}

export function searched(cwd: string): string[] {
  return [projectAdapters(cwd), homeAdapters()];
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

export type Picked = { found: Found } | { missing: string } | { conflict: string };

export function pick(list: Found[], role: string, name?: string): Picked {
  const implementations = list.filter((entry) => entry.role === role);
  const wanted = name ?? defaults().get(role);
  if (wanted !== undefined) {
    const found = implementations.find((entry) => entry.name === wanted);
    if (found !== undefined) return { found };
    const names = implementations.map((entry) => entry.name).join(", ");
    return {
      missing:
        implementations.length === 0
          ? `no ${role} adapter is installed. penguin list adapters shows what penguin found.`
          : `no ${role} adapter named ${wanted}. Installed: ${names}.`,
    };
  }
  const first = implementations[0];
  if (first === undefined) {
    return { missing: `no ${role} adapter is installed. penguin list adapters shows what penguin found.` };
  }
  if (implementations.length > 1) {
    const names = implementations.map((entry) => entry.name).join(", ");
    return {
      conflict: `${implementations.length} ${role} adapters are installed (${names}). Write "${role} <name>" to ${defaultsFile()} to choose one.`,
    };
  }
  return { found: first };
}

export function writeEnv(cwd: string, list: Found[]): void {
  writeEnvFile(home(), list);
  const project = projectHome(cwd);
  if (fs.existsSync(project)) writeEnvFile(project, list);
}

export function renderEnv(dir: string, list: Found[]): string {
  const chosen: Found[] = [];
  for (const role of [...new Set(list.map((entry) => entry.role))].sort()) {
    if (role === "agent" || role === "view") continue;
    const picked = pick(list, role);
    if ("found" in picked) chosen.push(picked.found);
  }
  const imports = chosen.map(
    (entry, index) => `import type adapter${index} from "${specifier(dir, entry.file)}";`,
  );
  const fields = chosen.map(
    (entry, index) => `    ${entry.role}: ReturnType<(typeof adapter${index})["build"]>;`,
  );
  const body =
    chosen.length === 0
      ? "export {};\n"
      : `${imports.join("\n")}\n\ndeclare module "penguin" {\n  interface Adapters {\n${fields.join("\n")}\n  }\n}\n`;
  return `// penguin writes this file from the installed adapters. Do not edit.\n${body}`;
}

function writeEnvFile(dir: string, list: Found[]): void {
  const content = renderEnv(dir, list);
  const file = envFile(dir);
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return;
  fs.writeFileSync(file, content);
}

function specifier(dir: string, file: string): string {
  const relative = path.relative(dir, file);
  if (relative.startsWith("..")) return file;
  return `./${relative}`;
}

async function scan(dir: string, scope: Scope): Promise<Found[]> {
  if (!fs.existsSync(dir)) return [];
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .filter((entry) => entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
    .map((entry) => entry.name)
    .sort();
  const found: Found[] = [];
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
