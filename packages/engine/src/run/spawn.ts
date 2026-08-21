import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, spawn } from "node:child_process";
import type { CommandResult, ExecOptions, ShellOptions } from "../core/adapter.ts";

export type Children = Set<ChildProcess>;

const active: Children = new Set();
const scope = new AsyncLocalStorage<Children>();

export function killActive(): void {
  for (const child of active) child.kill("SIGTERM");
}

export function children(): Children {
  return new Set();
}

export function inScope<T>(set: Children, body: () => Promise<T>): Promise<T> {
  return scope.run(set, body);
}

export function kill(set: Children): void {
  for (const child of set) child.kill("SIGTERM");
}

function track(child: ChildProcess): () => void {
  const set = scope.getStore();
  active.add(child);
  set?.add(child);
  return () => {
    active.delete(child);
    set?.delete(child);
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
    const done = track(child);
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
      done();
      reject(error);
    });
    child.on("close", (code) => {
      done();
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
    const done = track(child);
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
      done();
      reject(error);
    });
    child.on("close", (code) => {
      done();
      resolve(code ?? 1);
    });
  });
}
