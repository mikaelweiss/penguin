#!/usr/bin/env node

import childProcess from "child_process";
import fs from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));

const platform = os.platform();
const arch = os.arch();
const name = `@mikaelweiss/penguin-${platform}-${arch}`;
const source = platform === "win32" ? "pn.exe" : "pn";
const target = path.join(here, "bin", "pn.exe");

function resolveBinary() {
  const found = require.resolve(`${name}/package.json`);
  const binary = path.join(path.dirname(found), "bin", source);
  if (!fs.existsSync(binary)) throw new Error(`no binary at ${binary}`);
  return binary;
}

function copyBinary(from) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.unlinkSync(target);
  try {
    fs.linkSync(from, target);
  } catch {
    fs.copyFileSync(from, target);
  }
  fs.chmodSync(target, 0o755);
}

function installPackage() {
  const version = manifest.optionalDependencies?.[name];
  if (!version) return false;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-install-"));
  try {
    const done = childProcess.spawnSync(
      "npm",
      ["install", "--ignore-scripts", "--no-save", "--loglevel=error", "--prefix", temp, `${name}@${version}`],
      { stdio: "inherit", windowsHide: true },
    );
    if (done.status !== 0) return false;
    copyBinary(path.join(temp, "node_modules", name, "bin", source));
    return true;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function works() {
  const done = childProcess.spawnSync(target, ["--version"], { stdio: "ignore", windowsHide: true });
  return done.status === 0;
}

try {
  let ready = false;
  try {
    copyBinary(resolveBinary());
    ready = works();
  } catch {
    ready = false;
  }
  if (!ready && installPackage()) ready = works();
  if (!ready) {
    throw new Error(
      `penguin has no build for ${platform}-${arch}. Your package manager may have skipped ${name}, so try installing it directly.`,
    );
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
