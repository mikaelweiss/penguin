import os from "node:os";
import path from "node:path";

export function home(): string {
  const override = process.env["PENGUIN_HOME"];
  if (override !== undefined && override !== "") return path.resolve(override);
  return path.join(os.homedir(), ".penguin");
}

export function stateRoot(): string {
  const base = process.env["XDG_STATE_HOME"];
  if (base !== undefined && base !== "") return path.join(path.resolve(base), "penguin");
  return path.join(os.homedir(), ".local", "state", "penguin");
}

export function runsRoot(): string {
  return path.join(stateRoot(), "runs");
}

export function projectHome(cwd: string): string {
  return path.join(cwd, ".penguin");
}

export function runDir(name: string): string {
  return path.join(runsRoot(), name);
}

export function defaultsFile(): string {
  return path.join(home(), "defaults");
}

export function catalogsFile(): string {
  return path.join(home(), "catalogs");
}

export function envFile(dir: string): string {
  return path.join(dir, "penguin-env.d.ts");
}

export function eventsPath(dir: string): string {
  return path.join(dir, "events.jsonl");
}

export function inboxPath(dir: string): string {
  return path.join(dir, "inbox.jsonl");
}

export function runJsonPath(dir: string): string {
  return path.join(dir, "run.json");
}

export function transcriptsDir(dir: string): string {
  return path.join(dir, "transcripts");
}
