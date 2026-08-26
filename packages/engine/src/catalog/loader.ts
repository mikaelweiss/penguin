import path from "node:path";
import { pathToFileURL } from "node:url";
import * as zod from "zod";
import { PenguinError } from "../core/errors.ts";
import type { Workflow } from "../core/workflow.ts";
import { roots, workflowsDir, type Catalog } from "./catalogs.ts";
import { foundIn } from "./workflows.ts";

/** What a definition file names another catalog's workflow with: `penguin:open-pr`. */
const COMPOSED = "penguin:";

/** The workflow folders the plugin was registered for, so an unchanged search path registers once. */
let serving = "";

/** The file every composable name resolves to, as the last registration read them. */
let composed = new Map<string, string>();

/**
 * Definition files import `penguin` and `zod` bare, with no install of their
 * own. Virtual modules serve those names from penguin's own copies, which also
 * live inside a compiled binary, never on disk. The namespaces are imported
 * statically, because a dynamic import of `zod` would resolve back through
 * this plugin.
 *
 * `penguin:<name>` is another catalog's workflow, served from the same search
 * path the launcher starts one from, so a catalog composes what it does not
 * hold instead of keeping a copy that drifts. The list is the run's own, which
 * is why it is passed in: an import carries no run.
 */
export function register(list?: Catalog[]): void {
  const scanning = list ?? roots(process.cwd());
  const key = scanning.map(workflowsDir).join("\n");
  if (key === serving) return;
  serving = key;
  composed = composable(scanning);
  Bun.plugin({
    name: "penguin-definitions",
    setup(build) {
      build.module("penguin", async () => ({
        exports: { ...(await import("../core/index.ts")) },
        loader: "object",
      }));
      build.module("zod", () => ({ exports: { ...zod }, loader: "object" }));
      for (const [name, file] of composed) {
        build.module(`${COMPOSED}${name}`, async () => ({
          exports: { ...(await import(pathToFileURL(file).href)) },
          loader: "object",
        }));
      }
    },
  });
}

/** The file each name resolves to, nearest catalog first: exactly what the launcher would start. */
function composable(list: Catalog[]): Map<string, string> {
  const held = new Map<string, string>();
  for (const entry of foundIn(list)) if (!held.has(entry.name)) held.set(entry.name, entry.file);
  return held;
}

/** A composed import naming nothing installed, said the way a missing skill is said. */
function unserved(error: unknown): PenguinError | undefined {
  const said = error instanceof Error ? error.message : String(error);
  const name = new RegExp(`Cannot find (?:package|module) '${COMPOSED}([^']+)'`).exec(said)?.[1];
  if (name === undefined) return undefined;
  const names = [...composed.keys()].join(", ");
  return new PenguinError(
    names === ""
      ? `no workflow named ${name} is installed`
      : `no workflow named ${name}. Installed: ${names}`,
  );
}

export async function importDefault(file: string, list?: Catalog[]): Promise<unknown> {
  register(list);
  const resolved = path.resolve(file);
  try {
    const loaded = (await import(pathToFileURL(resolved).href)) as {
      default?: unknown;
    };
    return loaded.default;
  } catch (error) {
    throw unserved(error) ?? error;
  }
}

export async function load(file: string, list?: Catalog[]): Promise<Workflow> {
  const definition = (await importDefault(file, list)) as Workflow | undefined;
  if (
    definition === undefined ||
    typeof definition !== "object" ||
    typeof definition.run !== "function" ||
    typeof definition.params?.parse !== "function"
  ) {
    throw new PenguinError(`${file} does not default-export a workflow`);
  }
  if (typeof definition.description !== "string" || definition.description.trim() === "") {
    throw new PenguinError(`${file} has no description`);
  }
  return definition;
}
