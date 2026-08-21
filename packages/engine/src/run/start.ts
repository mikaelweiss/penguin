import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Starts the detached run process, and gives back its pid. */
export function startRun(name: string): number {
  const entry = fileURLToPath(new URL("./runner.ts", import.meta.url));
  const child = spawn(process.execPath, [entry, name], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? 0;
}
