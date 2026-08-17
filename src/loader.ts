import fs from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { PenguinError } from "./errors.ts";
import type { Workflow } from "./types.ts";

let registered = false;
const workflowFiles = new Set<string>();

function isTypeScript(url: string): boolean {
  return url.startsWith("file:") && (url.endsWith(".ts") || url.endsWith(".mts"));
}

export function register(): void {
  if (registered) return;
  registered = true;
  const penguin = publicEntry();
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "penguin") return { url: penguin, shortCircuit: true };
      if (specifier === "zod" || specifier.startsWith("zod/")) {
        return nextResolve(specifier, { ...context, parentURL: import.meta.url });
      }
      const resolved = nextResolve(specifier, context);
      const parent = context.parentURL;
      if (parent !== undefined && workflowFiles.has(parent) && isTypeScript(resolved.url)) {
        workflowFiles.add(resolved.url);
      }
      return resolved;
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

export async function importDefault(file: string): Promise<unknown> {
  register();
  const url = pathToFileURL(file).href;
  if (isTypeScript(url)) workflowFiles.add(url);
  const loaded = (await import(url)) as {
    default?: unknown;
  };
  return loaded.default;
}

export async function load(file: string): Promise<Workflow> {
  const definition = (await importDefault(file)) as Workflow | undefined;
  if (
    definition === undefined ||
    typeof definition !== "function" ||
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

function publicEntry(): string {
  const self = import.meta.url;
  return new URL(self.endsWith(".ts") ? "./index.ts" : "./index.js", self).href;
}
