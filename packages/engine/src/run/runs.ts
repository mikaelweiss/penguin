import fs from "node:fs";
import { runDir, runJsonPath, runsRoot } from "../paths.ts";
import { holder } from "./lock.ts";
import { type RunRecord, readRun } from "./record.ts";

export type RunOnDisk = {
  name: string;
  dir: string;
  workflow: string;
  cwd: string;
  live: boolean;
  createdAt: number;
};

/** Every run on disk, live ones first, each side ordered by name. A frontend formats. */
export function runsOnDisk(): RunOnDisk[] {
  const root = runsRoot();
  if (!fs.existsSync(root)) return [];
  const found: RunOnDisk[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = runDir(entry.name);
    if (!fs.existsSync(runJsonPath(dir))) continue;
    let record: RunRecord;
    try {
      record = readRun(dir);
    } catch {
      continue;
    }
    found.push({
      name: entry.name,
      dir,
      workflow: record.workflow,
      cwd: record.cwd,
      live: holder(dir) !== undefined,
      createdAt: Date.parse(record.createdAt),
    });
  }
  found.sort((left, right) => {
    if (left.live !== right.live) return left.live ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  return found;
}
