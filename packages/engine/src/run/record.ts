import fs from "node:fs";
import { PenguinError } from "../core/errors.ts";
import { runJsonPath } from "../paths.ts";

export type RunRecord = {
  workflow: string;
  cwd: string;
  params: unknown;
  createdAt: string;
};

export function readRun(dir: string): RunRecord {
  const file = runJsonPath(dir);
  if (!fs.existsSync(file)) throw new PenguinError(`no run at ${dir}`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as RunRecord;
}
