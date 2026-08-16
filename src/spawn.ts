import { type ChildProcess, spawn } from "node:child_process";
import type { CommandResult, ExecOptions, ShellOptions } from "./types.ts";

const active = new Set<ChildProcess>();

export function killActive(): void {
  for (const child of active) child.kill("SIGTERM");
}

export function runCommand(
  cmd: string,
  cwd: string,
  options?: Pick<ShellOptions, "stdin">,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, {
      shell: true,
      cwd,
      stdio: [options?.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    active.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    if (options?.stdin !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.stdin);
    }
    child.on("error", (error) => {
      active.delete(child);
      reject(error);
    });
    child.on("close", (code) => {
      active.delete(child);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function runArgv(argv: string[], cwd: string, options?: ExecOptions): Promise<number> {
  const [cmd, ...args] = argv;
  if (cmd === undefined) return Promise.resolve(1);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: [options?.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    active.add(child);
    const forward = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      options?.onOutput?.(chunk.toString(), stream);
    };
    child.stdout?.on("data", forward("stdout"));
    child.stderr?.on("data", forward("stderr"));
    if (options?.stdin !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.stdin);
    }
    child.on("error", (error) => {
      active.delete(child);
      reject(error);
    });
    child.on("close", (code) => {
      active.delete(child);
      resolve(code ?? 1);
    });
  });
}
