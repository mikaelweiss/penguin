import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Starts the detached run process, and gives back its pid. */
export function startRun(name: string): number {
  // A compiled binary has no entry file on disk and re-runs itself.
  const entry = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const args = fs.existsSync(entry) ? [entry, "_run", name] : ["_run", name];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? 0;
}
