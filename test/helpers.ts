import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

export const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const runner = fileURLToPath(import.meta.url);

export type Result = { code: number; stdout: string; stderr: string; output: string };

/** One question the fake terminal waits for, and the keys it answers with. */
export type TtyStep = { await: string; send?: string; remove?: string };

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
      const envelopes = turn.schema?.properties?.blocked !== undefined;
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

const clockSource = `import fs from "node:fs";
import { adapter } from "penguin";

export default adapter({
  role: "clock",
  name: "clock",
  description: "test clock",
  build: (host) => ({
    until: (file) =>
      host.wait("new commits", () =>
        new Promise((resolve) => {
          const tick = () => (fs.existsSync(file) ? resolve(file) : setTimeout(tick, 20));
          tick();
        }),
      ),
  }),
});
`;

export type Sandbox = {
  home: string;
  state: string;
  runs: string;
  userHome: string;
  project: string;
  writeSkill(dir: string, name: string, text: string): void;
  penguin(...args: string[]): Result;
  penguinWith(extra: Record<string, string>, ...args: string[]): Result;
  tty(steps: TtyStep[], ...args: string[]): Promise<Result>;
  start(...args: string[]): ChildProcess;
  write(relative: string, text: string): string;
  writeWorkflow(name: string, text: string, scope?: "home" | "project"): string;
  homeWorkflow(name: string): string;
  read(relative: string): string;
  exists(relative: string): boolean;
  lines(relative: string): string[];
  invocations(relative: string): string[];
  setAgent(result: string, marker?: string, name?: string): void;
  withShell(): void;
  withClock(): void;
  writeAdapter(name: string, source: string, scope?: "home" | "project"): void;
  setDefaults(text: string): void;
  sessions(): SessionLine[];
  runDir(run: string): string;
  events(run: string): Event[];
  send(run: string, text: string, session?: string, gate?: string): void;
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
  const state = path.join(userHome, ".local", "state");
  const runs = path.join(state, "penguin", "runs");
  const project = path.join(root, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(userHome);
  fs.mkdirSync(project);
  const sessionLog = path.join(root, "agent-log.jsonl");
  t.after(() => {
    stopRuns(runs);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const env = { ...process.env, PENGUIN_HOME: home, HOME: userHome, XDG_STATE_HOME: state };
  const box: Sandbox = {
    home,
    state,
    runs,
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
    tty(steps, ...args) {
      const child = spawn(process.execPath, [runner, ...args], {
        cwd: project,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let read = 0;
      let at = 0;
      let sent = "";
      let settle: ReturnType<typeof setTimeout> | undefined;
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const answer = (): void => {
        for (;;) {
          const step = steps[at];
          if (step === undefined) return quietly();
          const found = stdout.indexOf(step.await, read);
          if (found === -1) return quietly();
          read = found + step.await.length;
          at += 1;
          if (step.remove !== undefined) fs.rmSync(step.remove, { force: true });
          if (step.send !== undefined) {
            sent = step.send;
            child.stdin?.write(sent);
          }
        }
      };
      /** A key the question drops still draws nothing a second later, so send it again. */
      const quietly = (): void => {
        quiet = setTimeout(() => {
          if (sent !== "") child.stdin?.write(sent);
          quiet = setTimeout(() => child.kill("SIGKILL"), 15_000);
        }, 1_500);
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        clearTimeout(settle);
        clearTimeout(quiet);
        // The question takes keys once its frame is drawn and its handler is mounted.
        settle = setTimeout(answer, 60);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      // The last key can land on a run that already started and closed its pipe.
      child.stdin?.on("error", () => {});
      return new Promise((resolve) => {
        child.on("close", (code) => {
          clearTimeout(settle);
          clearTimeout(quiet);
          const missed = at === steps.length ? "" : `nothing drew ${JSON.stringify(steps[at]?.await)}\n`;
          resolve({ code: code ?? 1, stdout, stderr: stderr + missed, output: stdout + stderr + missed });
        });
      });
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
    writeWorkflow(name, text, scope = "project") {
      const dir =
        scope === "home"
          ? path.join(home, "workflows")
          : path.join(project, ".penguin", "workflows");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${name}.ts`);
      fs.writeFileSync(file, text);
      return file;
    },
    homeWorkflow(name) {
      return path.join(home, "workflows", `${name}.ts`);
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
    withClock() {
      box.writeAdapter("clock", clockSource);
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
      return path.join(runs, run);
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
    send(run, text, session, gate) {
      const line = { at: new Date().toISOString(), text, session, gate };
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

export function waitFor(check: () => boolean, timeoutMs = 30_000): Promise<void> {
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

/**
 * As a script, this file is the terminal `box.tty` spawns: penguin's pipes say they are
 * a terminal, so it draws frames the parent reads and takes keys the parent writes.
 */
async function fakeTerminal(): Promise<void> {
  const input = process.stdin as NodeJS.ReadStream & { setRawMode: (raw: boolean) => NodeJS.ReadStream };
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = process.stdout;
  output.isTTY = true;
  output.columns = 100;
  output.rows = 30;
  await import("../src/cli.ts");
}

if (import.meta.main) await fakeTerminal();
