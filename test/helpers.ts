import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { Entry } from "../src/journal.ts";

export const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

export type Result = { code: number; stdout: string; stderr: string; output: string };

const fakeAgent = `const fs = require("node:fs");
const [, , result, marker] = process.argv;
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (marker) fs.appendFileSync(marker, prompt + "\\n---END---\\n");
  process.stdout.write("agent ran\\n");
  if (result === "none") return;
  const match = prompt.match(/\\S+result\\.json/);
  if (!match) return;
  fs.writeFileSync(match[0], result === "invalid" ? '{"wrong":true}' : result);
});
`;

export type Sandbox = {
  home: string;
  project: string;
  agentPath: string;
  wa(...args: string[]): Result;
  start(...args: string[]): ChildProcess;
  write(relative: string, text: string): string;
  read(relative: string): string;
  exists(relative: string): boolean;
  lines(relative: string): string[];
  invocations(relative: string): string[];
  setAgent(command: string): void;
  agentCommand(result: string, marker?: string): string;
  runDir(run: string): string;
  journal(run: string): Entry[];
};

export function sandbox(t: TestContext): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-test-"));
  const home = path.join(root, "wa-home");
  const project = path.join(root, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  const agentPath = path.join(root, "fake-agent.js");
  fs.writeFileSync(agentPath, fakeAgent);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const env = { ...process.env, WA_HOME: home };
  const box: Sandbox = {
    home,
    project,
    agentPath,
    wa(...args) {
      const done = spawnSync(process.execPath, [cli, ...args], {
        cwd: project,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = done.stdout ?? "";
      const stderr = done.stderr ?? "";
      return { code: done.status ?? 1, stdout, stderr, output: stdout + stderr };
    },
    start(...args) {
      return spawn(process.execPath, [cli, ...args], {
        cwd: project,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
    write(relative, text) {
      const file = path.join(project, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return file;
    },
    read(relative) {
      return fs.readFileSync(path.join(project, relative), "utf8");
    },
    exists(relative) {
      return fs.existsSync(path.join(project, relative));
    },
    lines(relative) {
      return box
        .read(relative)
        .split("\n")
        .filter((line) => line !== "");
    },
    invocations(relative) {
      if (!box.exists(relative)) return [];
      return box
        .read(relative)
        .split("\n---END---\n")
        .filter((prompt) => prompt.trim() !== "");
    },
    setAgent(command) {
      fs.writeFileSync(path.join(home, "agent"), `${command}\n`);
    },
    agentCommand(result, marker) {
      const target = marker === undefined ? "" : ` ${path.join(project, marker)}`;
      return `node ${agentPath} '${result}'${target}`;
    },
    runDir(run) {
      return path.join(home, "runs", run);
    },
    journal(run) {
      return fs
        .readFileSync(path.join(box.runDir(run), "journal.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Entry);
    },
  };
  return box;
}

export function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (check()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

export function exited(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });
}
