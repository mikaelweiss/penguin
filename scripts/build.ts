#!/usr/bin/env bun
import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateStarter, generatedFile } from "./generate-starter.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist");

export type Target = { os: "darwin" | "linux" | "win32"; arch: "arm64" | "x64" };

export const targets: Target[] = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "win32", arch: "arm64" },
  { os: "win32", arch: "x64" },
];

export function packageName(target: Target): string {
  return `@mikaelweiss/penguin-${target.os}-${target.arch}`;
}

export function outputDir(target: Target): string {
  return path.join(dist, `penguin-${target.os}-${target.arch}`);
}

export function binaryName(target: Target): string {
  return target.os === "win32" ? "pn.exe" : "pn";
}

function compileTarget(target: Target): string {
  return `bun-${target.os === "win32" ? "windows" : target.os}-${target.arch}`;
}

/** A binary carries the generated catalog, so a build refuses to ship a stale one. */
async function checkStarter(version: string): Promise<void> {
  const { source } = await generateStarter(version);
  if (fs.readFileSync(generatedFile, "utf8") === source) return;
  throw new Error(`${path.relative(root, generatedFile)} is stale. Run \`bun run generate\`.`);
}

async function buildOne(target: Target, version: string, manifest: Record<string, unknown>): Promise<void> {
  const dir = outputDir(target);
  fs.rmSync(dir, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [path.join(root, "apps", "cli", "src", "cli.ts")],
    target: "bun",
    compile: {
      target: compileTarget(target) as Bun.Build.CompileTarget,
      outfile: path.join(dir, "bin", binaryName(target)),
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`build failed for ${packageName(target)}`);
  }
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: packageName(target),
        version,
        description: manifest["description"],
        license: manifest["license"],
        repository: manifest["repository"],
        os: [target.os],
        cpu: [target.arch],
      },
      null,
      2,
    )}\n`,
  );
}

export async function build(only: Target[], skipInstall: boolean): Promise<string> {
  const manifest = (await Bun.file(path.join(root, "package.json")).json()) as Record<string, unknown>;
  const version = manifest["version"] as string;
  await checkStarter(version);
  if (!skipInstall) await $`bun install ${"--os=*"} ${"--cpu=*"}`.cwd(root).quiet();
  for (const target of only) {
    process.stdout.write(`building ${packageName(target)}\n`);
    await buildOne(target, version, manifest);
  }
  return version;
}

function hostTarget(): Target {
  const found = targets.find((target) => target.os === process.platform && target.arch === process.arch);
  if (found === undefined) throw new Error(`no penguin target for ${process.platform}-${process.arch}`);
  return found;
}

if (import.meta.main) {
  const single = process.argv.includes("--single");
  const version = await build(single ? [hostTarget()] : targets, process.argv.includes("--skip-install"));
  process.stdout.write(`penguin ${version} in ${path.relative(root, dist)}\n`);
}
