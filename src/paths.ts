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
