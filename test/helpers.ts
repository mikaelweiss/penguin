import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

export const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

export type Result = { code: number; stdout: string; stderr: string; output: string };

export type Event = Record<string, unknown>;

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
import { adapter } from "penguin";

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
      if (turn.prompt.includes("<slow>")) {
        await host.shell("echo $$ > slow.pid; sleep 5 >/dev/null 2>&1; echo late > late.txt");
      }
      if (result === "none") return { ok: true, value: null };
      if (result === "invalid") return { ok: true, value: { wrong: true } };
      let value = JSON.parse(result);
      const envelopes = turn.schema !== undefined && Array.isArray(turn.schema.anyOf);
      if (envelopes && value.result === undefined && value.blocked === undefined) {
        value = { result: value };
      }
      return { ok: true, value };
    },
  }),
});
`;
}

const shellSource = `import { adapter } from "penguin";

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
  penguin(...args: string[]): Result;
  penguinWith(extra: Record<string, string>, ...args: string[]): Result;
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
  events(run: string): Event[];
  send(run: string, text: string, session?: string): void;
  holder(run: string): number | undefined;
  lastState(run: string): Event | undefined;
  ended(run: string): Event | undefined;
  waitForState(run: string, state: string, timeoutMs?: number): Promise<void>;
  waitForEnd(run: string, timeoutMs?: number): Promise<Event>;
};

export function sandbox(t: TestContext): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "penguin-test-")));
  const home = path.join(root, "penguin-home");
  const userHome = path.join(root, "user-home");
  const project = path.join(root, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(userHome);
  fs.mkdirSync(project);
  const sessionLog = path.join(root, "agent-log.jsonl");
  t.after(() => {
    stopRuns(path.join(home, "runs"));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const env = { ...process.env, PENGUIN_HOME: home, HOME: userHome };
  const box: Sandbox = {
    home,
    userHome,
    project,
    writeSkill(dir, name, text) {
      const file = path.join(dir, name, "SKILL.md");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
    penguin(...args) {
      return box.penguinWith({}, ...args);
    },
    penguinWith(extra, ...args) {
      const done = spawnSync(process.execPath, [cli, ...args], {
        cwd: project,
        env: { ...env, ...extra },
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
      const dir = scope === "home" ? path.join(home, "adapters") : path.join(project, ".penguin", "adapters");
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
    events(run) {
      const file = path.join(box.runDir(run), "events.jsonl");
      if (!fs.existsSync(file)) return [];
      return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Event);
    },
    send(run, text, session) {
      const line = { at: new Date().toISOString(), text, session };
      fs.appendFileSync(path.join(box.runDir(run), "inbox.jsonl"), `${JSON.stringify(line)}\n`);
    },
    holder(run) {
      return pidOf(path.join(box.runDir(run), "lock"));
    },
    lastState(run) {
      return box
        .events(run)
        .filter((event) => event["type"] === "state")
        .at(-1);
    },
    ended(run) {
      return box
        .events(run)
        .find((event) => event["type"] === "run" && event["phase"] !== "started");
    },
    waitForState(run, state, timeoutMs) {
      return waitFor(() => box.lastState(run)?.["state"] === state, timeoutMs);
    },
    async waitForEnd(run, timeoutMs) {
      await waitFor(() => box.ended(run) !== undefined, timeoutMs);
      return box.ended(run) as Event;
    },
  };
  return box;
}

function pidOf(lock: string): number | undefined {
  if (!fs.existsSync(lock)) return undefined;
  const pid = Number(fs.readFileSync(lock, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : undefined;
  }
}

function stopRuns(runs: string): void {
  if (!fs.existsSync(runs)) return;
  for (const entry of fs.readdirSync(runs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pid = pidOf(path.join(runs, entry.name, "lock"));
    if (pid === undefined) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
  }
}

export type Screen = { input: PassThrough; text(): string; stop(): string };

export function terminal(t: TestContext, home: string): Screen {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(on: boolean): void };
  input.isTTY = true;
  input.setRawMode = () => {};
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
  const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const write = process.stdout.write.bind(process.stdout);
  const penguinHome = process.env["PENGUIN_HOME"];
  const chunks: string[] = [];
  let stopped = false;
  const restore = (): string => {
    if (stopped) return chunks.join("");
    stopped = true;
    process.stdout.write = write;
    if (stdin !== undefined) Object.defineProperty(process, "stdin", stdin);
    if (isTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdout, "isTTY", isTTY);
    if (penguinHome === undefined) delete process.env["PENGUIN_HOME"];
    else process.env["PENGUIN_HOME"] = penguinHome;
    return chunks.join("");
  };
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  process.env["PENGUIN_HOME"] = home;
  t.after(restore);
  return { input, text: () => chunks.join(""), stop: restore };
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
