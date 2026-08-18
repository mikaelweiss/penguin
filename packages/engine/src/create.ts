import fs from "node:fs";
import path from "node:path";
import { PenguinError } from "./errors.ts";
import { inboxPath, runDir, runJsonPath, runsRoot, transcriptsDir } from "./paths.ts";

export type RunRecord = {
  workflow: string;
  cwd: string;
  params: unknown;
  createdAt: string;
};

export function createRun(file: string, params: unknown): string {
  const { name, dir } = allocateRun(file);
  finishRun(dir, file, params);
  return name;
}

/** Claims the run's name and directory. Until finishRun, no command sees it. */
export function allocateRun(file: string): { name: string; dir: string } {
  const stem = path.basename(file).replace(/\.[^.]+$/, "");
  fs.mkdirSync(runsRoot(), { recursive: true });
  for (let n = 1; ; n += 1) {
    const name = `${stem}-${n}`;
    const dir = runDir(name);
    try {
      fs.mkdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    return { name, dir };
  }
}

export function finishRun(dir: string, file: string, params: unknown): void {
  fs.mkdirSync(transcriptsDir(dir), { recursive: true });
  const record: RunRecord = {
    workflow: file,
    cwd: process.cwd(),
    params,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(runJsonPath(dir), `${JSON.stringify(record, null, 2)}\n`);
  fs.writeFileSync(inboxPath(dir), "");
}

/** Removes an allocated directory. A directory with a run.json is a run, and stays. */
export function discardRun(dir: string): void {
  if (fs.existsSync(runJsonPath(dir))) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

export function readRun(dir: string): RunRecord {
  const file = runJsonPath(dir);
  if (!fs.existsSync(file)) throw new PenguinError(`no run at ${dir}`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as RunRecord;
}
