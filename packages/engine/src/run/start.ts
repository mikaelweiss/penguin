import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { standalone } from "../binary.ts";

/** Starts the detached run process, and gives back its pid. */
export function startRun(name: string): number {
  // A compiled binary has no source file to launch, so it re-runs itself through the CLI command.
  const entry = fileURLToPath(new URL("./runner.ts", import.meta.url));
  const args = standalone() ? ["_run", name] : [entry, name];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? 0;
}
