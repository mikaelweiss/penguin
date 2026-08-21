import { spawn } from "node:child_process";
import path from "node:path";
import type { CommandResult, ExecOptions, Host, ShellOptions } from "./core/adapter.ts";
import { stateRoot } from "./paths.ts";

export function createHost(cwd: string): Host {
  const resolve = (relative: string | undefined): string => path.resolve(cwd, relative ?? ".");
  return {
    cwd,
    state: stateRoot(),
    shell: (cmd, options) => runCommand(cmd, resolve(options?.cwd), { stdin: options?.stdin }),
    exec: (argv, options) => runArgv(argv, resolve(options?.cwd), options),
  };
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
    child.on("error", reject);
    child.on("close", (code) => {
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
    const forward = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      options?.onOutput?.(chunk.toString(), stream);
    };
    child.stdout?.on("data", forward("stdout"));
    child.stderr?.on("data", forward("stderr"));
    if (options?.stdin !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.stdin);
    }
    child.on("error", reject);
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}
