import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { Entry } from "../src/journal.ts";

export const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

export type Result = { code: number; stdout: string; stderr: string; output: string };

export type SessionLine = {
  session: string;
  first: boolean;
  cwd: string;
  schema: unknown;
  options: Record<string, unknown>;
};

function fakeAgentSource(
  name: string,
  result: string,
  marker: string | undefined,
  log: string,
): string {
  return `import fs from "node:fs";
import { adapter } from "wa";

const result = ${JSON.stringify(result)};
const marker = ${JSON.stringify(marker ?? null)};
const log = ${JSON.stringify(log)};

export default adapter({
  role: "agent",
  name: ${JSON.stringify(name)},
  description: "fake test agent",
  build: (host) => ({
    async turn(turn) {
      if (marker !== null) fs.appendFileSync(marker, turn.prompt + "\\n---END---\\n");
      const line = {
        session: turn.session,
        first: turn.first,
        cwd: turn.cwd,
        schema: turn.schema ?? null,
        options: turn.options,
      };
      fs.appendFileSync(log, JSON.stringify(line) + "\\n");
      host.emit({ type: "agent", session: turn.session, kind: "output", text: "agent ran\\n" });
      if (result === "none") return { ok: true, value: null };
      if (result === "invalid") return { ok: true, value: { wrong: true } };
      return { ok: true, value: JSON.parse(result) };
    },
  }),
});
`;
}

const shellSource = `import { adapter } from "wa";

export default adapter({
  role: "shell",
  name: "shell",
  description: "test shell",
  build: (host) => ({
    run: (cmd, options) => host.shell(cmd, options),
  }),
});
`;

export type Sandbox = {
  home: string;
  userHome: string;
  project: string;
  writeSkill(dir: string, name: string, text: string): void;
  wa(...args: string[]): Result;
  start(...args: string[]): ChildProcess;
  write(relative: string, text: string): string;
  read(relative: string): string;
  exists(relative: string): boolean;
  lines(relative: string): string[];
  invocations(relative: string): string[];
  setAgent(result: string, marker?: string, name?: string): void;
  withShell(): void;
  writeAdapter(name: string, source: string, scope?: "home" | "project"): void;
  setDefaults(text: string): void;
  sessions(): SessionLine[];
  runDir(run: string): string;
  journal(run: string): Entry[];
  events(run: string): Record<string, unknown>[];
};

export function sandbox(t: TestContext): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wa-test-")));
  const home = path.join(root, "wa-home");
  const userHome = path.join(root, "user-home");
  const project = path.join(root, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(userHome);
  fs.mkdirSync(project);
  const sessionLog = path.join(root, "agent-log.jsonl");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const env = { ...process.env, WA_HOME: home, HOME: userHome };
  const box: Sandbox = {
    home,
    userHome,
    project,
    writeSkill(dir, name, text) {
      const file = path.join(dir, name, "SKILL.md");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
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
    setAgent(result, marker, name = "fake") {
      const target = marker === undefined ? undefined : path.join(project, marker);
      box.writeAdapter(name, fakeAgentSource(name, result, target, sessionLog));
    },
    withShell() {
      box.writeAdapter("shell", shellSource);
    },
    writeAdapter(name, source, scope = "home") {
      const dir = scope === "home" ? path.join(home, "adapters") : path.join(project, ".wa", "adapters");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${name}.ts`), source);
    },
    setDefaults(text) {
      fs.writeFileSync(path.join(home, "defaults"), `${text}\n`);
    },
    sessions() {
      if (!fs.existsSync(sessionLog)) return [];
      return fs
        .readFileSync(sessionLog, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as SessionLine);
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
    events(run) {
      const file = path.join(box.runDir(run), "events.jsonl");
      if (!fs.existsSync(file)) return [];
      return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
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
