import fs from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { WaError } from "./errors.ts";
import type { Workflow } from "./types.ts";

let registered = false;
const workflowFiles = new Set<string>();

export function register(): void {
  if (registered) return;
  registered = true;
  const wa = publicEntry();
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "wa") return { url: wa, shortCircuit: true };
      if (specifier === "zod" || specifier.startsWith("zod/")) {
        return nextResolve(specifier, { ...context, parentURL: import.meta.url });
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!workflowFiles.has(url)) return nextLoad(url, context);
      return {
        format: "module-typescript" as typeof context.format,
        source: fs.readFileSync(new URL(url), "utf8"),
        shortCircuit: true,
      };
    },
  });
}

export async function load(file: string): Promise<Workflow> {
  register();
  const url = pathToFileURL(file).href;
  if (url.endsWith(".ts") || url.endsWith(".mts")) workflowFiles.add(url);
  const loaded = (await import(url)) as {
    default?: unknown;
  };
  const definition = loaded.default as Workflow | undefined;
  if (
    definition === undefined ||
    typeof definition !== "object" ||
    typeof definition.run !== "function" ||
    typeof definition.params?.parse !== "function"
  ) {
    throw new WaError(`${file} does not default-export a workflow`);
  }
  return definition;
}

function publicEntry(): string {
  const self = import.meta.url;
  return new URL(self.endsWith(".ts") ? "./index.ts" : "./index.js", self).href;
}
