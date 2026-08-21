import path from "node:path";
import { pathToFileURL } from "node:url";
import * as zod from "zod";
import { PenguinError } from "../core/errors.ts";
import type { Workflow } from "../core/workflow.ts";

let registered = false;

/**
 * Definition files import `penguin` and `zod` bare, with no install of their
 * own. Virtual modules serve those names from penguin's own copies, which also
 * live inside a compiled binary, never on disk. The namespaces are imported
 * statically, because a dynamic import of `zod` would resolve back through
 * this plugin.
 */
export function register(): void {
  if (registered) return;
  registered = true;
  Bun.plugin({
    name: "penguin-definitions",
    setup(build) {
      build.module("penguin", async () => ({
        exports: { ...(await import("../core/index.ts")) },
        loader: "object",
      }));
      build.module("zod", () => ({ exports: { ...zod }, loader: "object" }));
    },
  });
}

export async function importDefault(file: string): Promise<unknown> {
  register();
  const resolved = path.resolve(file);
  const loaded = (await import(pathToFileURL(resolved).href)) as {
    default?: unknown;
  };
  return loaded.default;
}

export async function load(file: string): Promise<Workflow> {
  const definition = (await importDefault(file)) as Workflow | undefined;
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
