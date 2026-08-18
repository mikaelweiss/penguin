#!/usr/bin/env bun
import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, outputDir, packageName, targets } from "./build.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist");
const launchers = ["@mikaelweiss/penguin", "falcra"];

function placeholder(name: string): string {
  return [
    `echo "penguin's postinstall script did not run, so the binary is not here." >&2`,
    'echo "" >&2',
    'echo "That happens with --ignore-scripts, and with package managers that skip" >&2',
    'echo "postinstall by default. To finish the install, run:" >&2',
    `echo "  cd node_modules/${name} && node postinstall.mjs" >&2`,
    "exit 1",
    "",
  ].join("\n");
}

async function published(name: string, version: string): Promise<boolean> {
  return (await $`npm view ${name}@${version} version`.nothrow().quiet()).exitCode === 0;
}

async function publish(dir: string, name: string, version: string, dry: boolean): Promise<void> {
  if (!dry && (await published(name, version))) {
    process.stdout.write(`already published ${name}@${version}\n`);
    return;
  }
  for (const file of fs.readdirSync(dir)) if (file.endsWith(".tgz")) fs.rmSync(path.join(dir, file));
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir).quiet();
  const packed = await $`bun pm pack`.cwd(dir).text();
  if (dry) {
    process.stdout.write(`packed ${name}@${version}: ${packed.match(/Packed size: .*/)?.[0] ?? "unknown size"}\n`);
    return;
  }
  await $`npm publish --access public *.tgz`.cwd(dir);
  process.stdout.write(`published ${name}@${version}\n`);
}

function writeLauncher(name: string, version: string, manifest: Record<string, unknown>): string {
  const dir = path.join(dist, `launcher-${name.replace("@mikaelweiss/", "")}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "pn.exe"), placeholder(name), { mode: 0o755 });
  fs.copyFileSync(path.join(root, "scripts", "postinstall.mjs"), path.join(dir, "postinstall.mjs"));
  fs.copyFileSync(path.join(root, "LICENSE"), path.join(dir, "LICENSE"));
  fs.copyFileSync(path.join(root, "README.md"), path.join(dir, "README.md"));
  const optional = Object.fromEntries(targets.map((target) => [packageName(target), version]));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version,
        description: manifest["description"],
        license: manifest["license"],
        repository: manifest["repository"],
        bin: { pn: "./bin/pn.exe" },
        scripts: { postinstall: "node ./postinstall.mjs" },
        os: ["darwin", "linux", "win32"],
        cpu: ["arm64", "x64"],
        optionalDependencies: optional,
      },
      null,
      2,
    )}\n`,
  );
  return dir;
}

if (import.meta.main) {
  const manifest = (await Bun.file(path.join(root, "package.json")).json()) as Record<string, unknown>;
  const dry = process.argv.includes("--dry-run");
  const version = await build(targets, process.argv.includes("--skip-install"));
  for (const target of targets) await publish(outputDir(target), packageName(target), version, dry);
  for (const name of launchers) await publish(writeLauncher(name, version, manifest), name, version, dry);
  process.stdout.write(dry ? `\npenguin ${version} packed, nothing published\n` : `\npenguin ${version} is out\n`);
}
