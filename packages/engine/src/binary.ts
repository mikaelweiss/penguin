import path from "node:path";

/** True when penguin runs as a compiled binary, false when Bun runs its source. */
export function standalone(): boolean {
  return path.basename(process.execPath).replace(/\.exe$/, "") !== "bun";
}
