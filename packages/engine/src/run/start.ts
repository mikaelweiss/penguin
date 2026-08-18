import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Starts the detached run process, and gives back its pid. */
export function startRun(name: string): number {
  // A program with no source file on disk re-runs itself through the CLI command.
  const entry = fileURLToPath(new URL("./runner.ts", import.meta.url));
  const args = fs.existsSync(entry) ? [entry, name] : ["_run", name];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? 0;
}
