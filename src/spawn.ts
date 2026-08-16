import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import type { CommandResult } from "./types.ts";

const active = new Set<ChildProcess>();

export function killActive(): void {
  for (const child of active) child.kill("SIGTERM");
}

export function runCommand(cmd: string, cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, cwd, stdio: ["ignore", "pipe", "pipe"] });
    active.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
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

export function runAgent(
  cmd: string,
  cwd: string,
  prompt: string,
  transcript: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, cwd, stdio: ["pipe", "pipe", "pipe"] });
    active.add(child);
    const file = fs.createWriteStream(transcript);
    file.write(prompt);
    file.write("\n\n");
    const forward = (chunk: Buffer, to: NodeJS.WriteStream): void => {
      to.write(chunk);
      file.write(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => forward(chunk, process.stdout));
    child.stderr.on("data", (chunk: Buffer) => forward(chunk, process.stderr));
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    child.on("error", (error) => {
      active.delete(child);
      file.end();
      reject(error);
    });
    child.on("close", (code) => {
      active.delete(child);
      file.end();
      resolve(code ?? 1);
    });
  });
}
