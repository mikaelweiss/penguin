import { spawn } from "node:child_process";
import fs from "node:fs";

/** Starts the detached run process, and gives back its pid. */
export function startRun(name: string): number {
  const script = process.argv[1];
  const args =
    script !== undefined && fs.existsSync(script) ? [script, "_run", name] : ["_run", name];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? 0;
}
