import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PenguinError } from "./errors.ts";
import type { Workflow } from "./types.ts";

let registered = false;
const definitionFiles = new Set<string>();
const scanner = new Bun.Transpiler({ loader: "tsx" });

function isTypeScript(file: string): boolean {
  return /\.[cm]?tsx?$/.test(file);
}

/**
 * Definition files import `penguin` and `zod` bare, with no install of their own.
 * Bun resolves bare specifiers before runtime plugins see them, so the loader
 * rewrites those specifiers to absolute paths in the source instead.
 */
export function register(): void {
  if (registered) return;
  registered = true;
  Bun.plugin({
    name: "penguin-definitions",
    setup(build) {
      build.onLoad({ filter: /\.[cm]?tsx?$/ }, (args) => {
        const source = fs.readFileSync(args.path, "utf8");
        const tracked = definitionFiles.has(args.path);
        return {
          contents: tracked ? rewritten(args.path, source) : source,
          loader: args.path.endsWith("x") ? "tsx" : "ts",
        };
      });
    },
  });
}

function rewritten(file: string, source: string): string {
  let out = source;
  for (const found of scanner.scanImports(source)) {
    const specifier = found.path;
    if (specifier === "penguin") {
      out = redirect(out, specifier, penguinEntry());
    } else if (specifier === "zod" || specifier.startsWith("zod/")) {
      out = redirect(out, specifier, fileURLToPath(import.meta.resolve(specifier)));
    } else if (specifier.startsWith(".")) {
      const target = path.resolve(path.dirname(file), specifier);
      if (isTypeScript(target)) track(target);
    }
  }
  return out;
}

/** Same-line replacement in import positions only, so error line numbers hold. */
function redirect(source: string, specifier: string, target: string): string {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(from\\s*|import\\s*\\(\\s*|import\\s+)(["'])${escaped}\\2`, "g");
  return source.replace(pattern, (_, lead: string) => `${lead}${JSON.stringify(target)}`);
}

function track(file: string): void {
  definitionFiles.add(file);
  try {
    definitionFiles.add(fs.realpathSync(file));
  } catch {
    return;
  }
}

export async function importDefault(file: string): Promise<unknown> {
  register();
  const resolved = path.resolve(file);
  if (isTypeScript(resolved)) track(resolved);
  const loaded = (await import(pathToFileURL(resolved).href)) as {
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

function penguinEntry(): string {
  return fileURLToPath(new URL("./index.ts", import.meta.url));
}
