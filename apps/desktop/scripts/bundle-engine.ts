// Stages what the .app ships: the bun that runs the engine, and the engine itself.
// Both land in src-tauri, where tauri.conf.json picks them up as externalBin and resources.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repo = path.dirname(path.dirname(desktop));
const tauri = path.join(desktop, "src-tauri");

function fail(problem: string): never {
  console.error(problem);
  process.exit(1);
}

/** Tauri finds an external binary by the triple it was built for, so the copy carries it in its name. */
function triple(): string {
  const asked = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (asked.status !== 0) fail("rustc is not installed, so the target triple is unknown");
  const host = /^host:\s*(.+)$/m.exec(asked.stdout)?.[1];
  return host ?? fail("rustc printed no host triple");
}

function stageBun(): void {
  const found = Bun.which("bun") ?? fail("no bun on PATH to bundle");
  const source = fs.realpathSync(found);
  const target = path.join(tauri, "binaries", `bun-${triple()}`);
  if (fresh(source, target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);
  console.log(`bundled ${source}`);
}

function fresh(source: string, target: string): boolean {
  if (!fs.existsSync(target)) return false;
  return fs.statSync(target).mtimeMs >= fs.statSync(source).mtimeMs;
}

/** The engine runs from source on the bundled bun, so it ships as source, zod and types included. */
function stageEngine(): void {
  const target = path.join(tauri, "engine");
  fs.rmSync(target, { recursive: true, force: true });
  const engine = path.join(repo, "packages", "engine");
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(engine, "package.json"), path.join(target, "package.json"));
  fs.cpSync(path.join(engine, "src"), path.join(target, "src"), {
    recursive: true,
    filter: (from) => !from.endsWith(".test.ts"),
  });
  fs.cpSync(path.join(engine, "examples"), path.join(target, "examples"), { recursive: true });
  const staged = new Set<string>();
  // The types are here because penguin points a catalog's tsconfig at them, so an
  // author editing definition files gets the same resolution a checkout gives.
  for (const dependency of ["zod", "bun-pty", "@types/bun", "@types/node"]) {
    stagePackage(dependency, target, staged);
  }
  console.log(`staged ${engine}`);
}

/** Copies one package and what it depends on, flat, the way bun's hoisted install reads. */
function stagePackage(name: string, target: string, staged: Set<string>): void {
  if (staged.has(name)) return;
  staged.add(name);
  const source = path.join(repo, "node_modules", name);
  if (!fs.existsSync(source)) fail(`${name} is not installed, so the bundle cannot carry it`);
  fs.cpSync(source, path.join(target, "node_modules", name), {
    recursive: true,
    dereference: true,
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    stagePackage(dependency, target, staged);
  }
}

stageBun();
stageEngine();
