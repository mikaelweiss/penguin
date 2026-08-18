import fs from "node:fs";
import path from "node:path";
import { PenguinError } from "./errors.ts";

export function lockPath(dir: string): string {
  return path.join(dir, "lock");
}

export function holder(dir: string): number | undefined {
  const file = lockPath(dir);
  if (!fs.existsSync(file)) return undefined;
  const pid = Number(fs.readFileSync(file, "utf8").trim());
  return alive(pid) ? pid : undefined;
}

export function acquire(dir: string): () => void {
  const file = lockPath(dir);
  while (true) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(fs.readFileSync(file, "utf8").trim());
      if (alive(pid)) {
        throw new PenguinError(`run ${path.basename(dir)} is already executing (pid ${pid})`);
      }
      fs.rmSync(file, { force: true });
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.rmSync(file, { force: true });
  };
}

export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
