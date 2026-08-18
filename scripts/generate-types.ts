#!/usr/bin/env bun
import { $ } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function collect(dir: string, keep: (file: string) => boolean, prefix: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const key = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(files, collect(full, keep, key));
    else if (keep(entry.name)) files[key] = fs.readFileSync(full, "utf8");
  }
  return files;
}

/** Declaration files reference their siblings as `.js`, which resolves to the `.d.ts` beside them. */
function asDeclarationImports(source: string): string {
  return source.replace(/(from\s+"\.[^"]*)\.ts"/g, '$1.js"');
}

async function authorTypes(): Promise<Record<string, string>> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-types-"));
  try {
    await $`bunx tsc ${path.join(root, "packages/engine/src/author/index.ts")} \
      --declaration --emitDeclarationOnly --outDir ${out} \
      --module nodenext --moduleResolution nodenext --target es2023 \
      --strict --allowImportingTsExtensions --skipLibCheck`.quiet();
    const files = collect(out, (name) => name.endsWith(".d.ts"), "types/penguin");
    return Object.fromEntries(Object.entries(files).map(([key, text]) => [key, asDeclarationImports(text)]));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

function zodTypes(): Record<string, string> {
  const dir = path.join(root, "node_modules", "zod");
  const keep = (name: string): boolean =>
    name.endsWith(".d.ts") || name.endsWith(".d.cts") || name === "package.json";
  return collect(dir, keep, "types/zod");
}

function nodeTypes(): Record<string, string> {
  const keep = (name: string): boolean => name.endsWith(".d.ts") || name === "package.json";
  return {
    ...collect(path.join(root, "node_modules", "@types", "node"), keep, "types/@types/node"),
    ...collect(path.join(root, "node_modules", "undici-types"), keep, "types/undici-types"),
  };
}

export async function generateTypes(): Promise<Record<string, string>> {
  return { ...(await authorTypes()), ...zodTypes(), ...nodeTypes() };
}

if (import.meta.main) {
  const files = await generateTypes();
  const bytes = Object.values(files).reduce((total, text) => total + text.length, 0);
  process.stdout.write(`${Object.keys(files).length} declaration files, ${Math.round(bytes / 1024)} KB\n`);
}
