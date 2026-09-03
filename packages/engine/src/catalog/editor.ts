import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installedIn, pick, type AdapterFound } from "./adapters.ts";
import { workflowsDir, type Catalog, type CatalogScope } from "./catalogs.ts";

/**
 * Definition files import `penguin` and `zod` with no install of their own, so
 * only penguin knows where an editor can read those types: a source checkout
 * and the engine an app ships put them in different places. penguin writes the
 * answer from the running install, which is why these files are machine local
 * and why a .gitignore lands beside them.
 */

const TSCONFIG = "tsconfig.json";
const ENV = "penguin-env.d.ts";
const IGNORE = ".gitignore";
const WRITTEN = [TSCONFIG, ENV];
const MARK = "// penguin writes this file";

/** Catalogs inside the install are the package's own files; a person authors the rest. */
const AUTHORED = new Set<CatalogScope>(["project", "home", "catalog"]);

/** The folders the written tsconfig includes, so the gate and the config agree on what source is. */
const SOURCES = ["adapters", "helpers", "workflows"];

/** Refreshes the editor's half of every catalog a person authors, in place. */
export async function writeEditorFiles(list: Catalog[]): Promise<void> {
  for (const [index, catalog] of list.entries()) {
    if (!AUTHORED.has(catalog.scope) || !fs.existsSync(catalog.dir)) continue;
    if (!holdsSource(catalog.dir)) {
      sweep(catalog.dir);
      continue;
    }
    // A catalog is typed against itself and what it shadows, never against a
    // caller's folder, so the same catalog reads the same from every project.
    put(path.join(catalog.dir, ENV), env(await installedIn(list.slice(index))));
    put(path.join(catalog.dir, TSCONFIG), tsconfig(list.slice(index)));
    ignore(path.join(catalog.dir, IGNORE));
  }
}

/** An empty .penguin is a folder someone made, not a catalog, and it gets nothing to type. */
function holdsSource(dir: string): boolean {
  if (typescript(dir).some((name) => !WRITTEN.includes(name))) return true;
  return SOURCES.some((name) => typescript(path.join(dir, name)).length > 0);
}

function typescript(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".ts"));
  } catch {
    return [];
  }
}

/**
 * A stale answer still answers, so a catalog that loses its source loses the types written for it.
 * Only penguin's own files go, which is what the header on each of them is for.
 */
function sweep(dir: string): void {
  for (const name of WRITTEN) {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").startsWith(MARK)) fs.rmSync(file);
  }
}

function tsconfig(list: Catalog[]): string {
  const engine = engineRoot();
  const body = {
    compilerOptions: {
      target: "es2023",
      lib: ["es2023"],
      module: "nodenext",
      moduleResolution: "nodenext",
      // Naming the install's own roots keeps a project's unrelated @types out.
      typeRoots: modules("@types"),
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      paths: {
        penguin: [path.join(engine, "src", "core", "index.ts")],
        // A composed import reads as the run resolves it: the nearest catalog holding the name.
        "penguin:*": list.map((catalog) => path.join(workflowsDir(catalog), "*.ts")),
        zod: modules("zod"),
      },
    },
    include: ["*.ts", "adapters/*.ts", "helpers/*.ts", "workflows/*.ts"],
  };
  return `${header("running install")}\n${JSON.stringify(body, undefined, 2)}\n`;
}

/** Declaration merging is how ctx gets its type: one member per role the catalog resolves. */
function env(found: AdapterFound[]): string {
  const imports: string[] = [];
  const members: string[] = [];
  for (const role of new Set(found.map((entry) => entry.role))) {
    const picked = pick(found, role);
    // A role with no single answer has no single type either. The run says so.
    if (!("found" in picked)) continue;
    members.push(`    ${role}: ReturnType<(typeof adapter${imports.length})["build"]>;`);
    imports.push(`import type adapter${imports.length} from "${picked.found.file}";`);
  }
  return [
    header("installed adapters"),
    ...imports,
    "",
    'declare module "penguin" {',
    "  interface Adapters {",
    ...members,
    "  }",
    "}",
    "",
  ].join("\n");
}

/** Marks a file as penguin's, to rewrite and to remove. */
function header(source: string): string {
  return `${MARK} from the ${source}. Do not edit, do not commit.`;
}

/** The engine package, wherever this copy of it runs from. */
function engineRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

/** Every real copy above the install, because bun hoists and an app bundle does not. */
function modules(name: string): string[] {
  const found: string[] = [];
  let dir = engineRoot();
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(candidate)) found.push(candidate);
    const up = path.dirname(dir);
    if (up === dir) return found;
    dir = up;
  }
}

/** Rewrites only on a real change, so an editor watching the folder stays quiet. */
function put(file: string, text: string): void {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return;
  fs.writeFileSync(file, text);
}

/** Machine paths must not reach a repository, so the catalog ignores what penguin writes. */
function ignore(file: string): void {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = existing.split("\n").map((line) => line.trim());
  const missing = WRITTEN.filter((name) => !lines.includes(name));
  if (missing.length === 0) return;
  const kept = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  fs.writeFileSync(file, `${kept}${missing.join("\n")}\n`);
}
