import fs from "node:fs";
import path from "node:path";
import { messageOf, PenguinError } from "../errors.ts";
import { home } from "../paths.ts";
import { starterFiles, version } from "./starter.generated.ts";

export type StarterState =
  | { kind: "current" }
  | { kind: "missing" }
  | { kind: "stale"; installed: string }
  | { kind: "declined"; installed: string };

export function starterDir(): string {
  return path.join(home(), "starter");
}

export function backupsDir(): string {
  return path.join(home(), "backups");
}

function stampFile(dir: string): string {
  return path.join(dir, "version");
}

function stamp(dir: string): { installed: string; declined?: string } | undefined {
  const file = stampFile(dir);
  if (!fs.existsSync(file)) return undefined;
  const [installed, second] = fs.readFileSync(file, "utf8").split("\n");
  if (installed === undefined || installed.trim() === "") return undefined;
  const declined = second?.startsWith("declined ") === true ? second.slice("declined ".length).trim() : undefined;
  return declined === undefined ? { installed: installed.trim() } : { installed: installed.trim(), declined };
}

/** What the extracted starter catalog needs, if anything. */
export function starterState(): StarterState {
  const found = stamp(starterDir());
  if (found === undefined) return { kind: "missing" };
  if (found.installed === version) return { kind: "current" };
  if (found.declined === version) return { kind: "declined", installed: found.installed };
  return { kind: "stale", installed: found.installed };
}

/** Writes the starter catalog when it is not on disk. */
export function ensureStarter(): void {
  if (starterState().kind === "missing") extractStarter();
}

/** Writes the starter catalog this penguin carries, and answers where any tree already there went. */
export function extractStarter(): string | undefined {
  const dir = starterDir();
  const staging = `${dir}.writing-${process.pid}`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    for (const [relative, contents] of Object.entries(starterFiles)) {
      const file = path.join(staging, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
    fs.writeFileSync(stampFile(staging), `${version}\n`);
    const kept = fs.existsSync(dir) ? backupStarter() : undefined;
    fs.renameSync(staging, dir);
    return kept;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new PenguinError(`penguin could not write its catalog to ${dir}: ${messageOf(error)}`);
  }
}

/** Moves the extracted starter catalog aside, and answers where it went. */
export function backupStarter(): string {
  const dir = starterDir();
  const found = stamp(dir);
  const name = `starter-${found?.installed ?? "unknown"}`;
  fs.mkdirSync(backupsDir(), { recursive: true });
  let target = path.join(backupsDir(), name);
  for (let n = 2; fs.existsSync(target); n += 1) target = path.join(backupsDir(), `${name}-${n}`);
  fs.renameSync(dir, target);
  return target;
}

/** Records that the user kept the tree they have, so the same version never asks twice. */
export function declineStarter(): void {
  const dir = starterDir();
  const found = stamp(dir);
  if (found === undefined) return;
  fs.writeFileSync(stampFile(dir), `${found.installed}\ndeclined ${version}\n`);
}

export { version };
