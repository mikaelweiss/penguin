import os from "node:os";
import path from "node:path";

export function home(): string {
  const override = process.env["WA_HOME"];
  if (override !== undefined && override !== "") return path.resolve(override);
  return path.join(os.homedir(), ".wa");
}

export function runsRoot(): string {
  return path.join(home(), "runs");
}

export function homeSkills(): string {
  return path.join(home(), "skills");
}

export function projectHome(cwd: string): string {
  return path.join(cwd, ".wa");
}

export function projectSkills(cwd: string): string {
  return path.join(projectHome(cwd), "skills");
}

export type Scope = "local" | "global";

export function userRoot(): string {
  return os.homedir();
}

export function short(target: string): string {
  const root = userRoot();
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return target;
  return `~${target.slice(root.length)}`;
}

export function runDir(name: string): string {
  return path.join(runsRoot(), name);
}

export function agentFile(): string {
  return path.join(home(), "agent");
}

export function pinnedWorkflow(dir: string): string {
  return path.join(dir, "workflow.ts");
}

export function transcriptsDir(dir: string): string {
  return path.join(dir, "transcripts");
}
