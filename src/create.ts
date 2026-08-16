import fs from "node:fs";
import path from "node:path";
import * as journal from "./journal.ts";
import { pinnedWorkflow, runDir, runsRoot, transcriptsDir } from "./paths.ts";

export function createRun(file: string, params: unknown): string {
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
    fs.mkdirSync(transcriptsDir(dir));
    fs.copyFileSync(file, pinnedWorkflow(dir));
    journal.append(dir, {
      type: "start",
      workflow: file,
      cwd: process.cwd(),
      params,
      createdAt: new Date().toISOString(),
    });
    return name;
  }
}
