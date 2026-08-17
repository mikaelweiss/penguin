import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import * as adapters from "./adapters.ts";
import { readRun } from "./create.ts";
import { messageOf, WaError } from "./errors.ts";
import { Tail } from "./follow.ts";
import { alive, holder } from "./lock.ts";
import { eventsPath, inboxPath, runDir } from "./paths.ts";
import { interactive } from "./prompt.ts";
import { runArgv, runCommand } from "./spawn.ts";
import type { Host, ViewAdapter, ViewEvent } from "./types.ts";
import { plainRenderer } from "./view.ts";

const START_TIMEOUT = 10_000;
const WATCH = 500;

export async function attach(name: string, pid?: number): Promise<number> {
  const dir = runDir(name);
  if (!fs.existsSync(dir)) throw new WaError(`no run named ${name}`);
  const record = readRun(dir);
  const found = await adapters.installed(record.cwd);
  const viewer = new Viewer(name, build(found, record.cwd), agentLine(found));
  if (pid !== undefined && !(await started(dir, pid))) {
    process.stderr.write(`wa: the run process for ${name} died before it started\n`);
    return 1;
  }
  const tail = new Tail(eventsPath(dir), (line) => viewer.line(line));
  tail.read();
  const code = viewer.code();
  if (code !== undefined) return code;
  if (holder(dir) === undefined) return 0;
  return follow(dir, tail, viewer);
}

function follow(dir: string, tail: Tail, viewer: Viewer): Promise<number> {
  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      tail.stop();
      keys?.stop();
      resolve(code);
    };
    viewer.onEnd = finish;
    const watchdog = setInterval(() => {
      if (holder(dir) !== undefined) return;
      tail.read();
      if (settled) return;
      process.stderr.write("wa: the run process died\n");
      finish(1);
    }, WATCH);
    const keys = interactive() ? keyboard(dir, viewer, finish) : undefined;
    tail.follow();
  });
}

function keyboard(dir: string, viewer: Viewer, finish: (code: number) => void): { stop(): void } {
  const input = process.stdin;
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean }): void => {
    if (key.ctrl === true && key.name === "c") {
      viewer.stopRun(dir);
      return;
    }
    if (key.name === "tab") {
      viewer.cycle();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      viewer.send(dir);
      return;
    }
    if (key.name === "escape") {
      viewer.clear();
      return;
    }
    if (key.name === "backspace") {
      viewer.erase();
      return;
    }
    if (!viewer.typing() && key.name === "q") {
      finish(0);
      return;
    }
    if (text !== undefined && text.length === 1 && text >= " ") viewer.type(text);
  };
  input.on("keypress", onKey);
  return {
    stop(): void {
      input.off("keypress", onKey);
      input.setRawMode(false);
      input.pause();
    },
  };
}

class Viewer {
  onEnd: (code: number) => void = () => {};
  private name: string;
  private renderer: ViewAdapter;
  private agent: string;
  private tty = process.stdout.isTTY === true;
  private sessions = new Map<string, string>();
  private order: string[] = [];
  private selected: string | undefined;
  private buffer = "";
  private held: ViewEvent[] = [];
  private ended: number | undefined;

  constructor(name: string, renderer: ViewAdapter, agent: string) {
    this.name = name;
    this.renderer = renderer;
    this.agent = agent;
  }

  line(text: string): void {
    let event: ViewEvent;
    try {
      event = JSON.parse(text) as ViewEvent;
    } catch {
      return;
    }
    if (event.type === "session") {
      this.sessions.set(event.id, event.name);
      if (!this.order.includes(event.name)) this.order.push(event.name);
    }
    if (event.type === "run" && event.phase !== "started") {
      this.clear();
      this.show(event);
      return;
    }
    if (this.buffer !== "") {
      this.held.push(event);
      return;
    }
    this.show(event);
  }

  code(): number | undefined {
    return this.ended;
  }

  typing(): boolean {
    return this.buffer !== "";
  }

  type(text: string): void {
    this.buffer += text;
    this.prompt();
  }

  erase(): void {
    if (this.buffer === "") return;
    this.buffer = this.buffer.slice(0, -1);
    if (this.buffer === "") this.clear();
    else this.prompt();
  }

  clear(): void {
    if (this.buffer === "") return;
    this.buffer = "";
    this.erasePrompt();
    this.flush();
  }

  send(dir: string): void {
    const text = this.buffer;
    if (text === "") return;
    this.buffer = "";
    this.erasePrompt();
    const message = { at: new Date().toISOString(), text, session: this.selected };
    fs.appendFileSync(inboxPath(dir), `${JSON.stringify(message)}\n`);
    this.flush();
  }

  cycle(): void {
    const names = [undefined, ...this.order];
    const next = names[(names.indexOf(this.selected) + 1) % names.length];
    this.selected = next;
    this.write(`viewing: ${next ?? "all"}\n`);
  }

  stopRun(dir: string): void {
    const pid = holder(dir);
    if (pid === undefined) {
      this.onEnd(130);
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      this.onEnd(130);
    }
  }

  private show(event: ViewEvent): void {
    if (event.type === "run" && event.phase === "started") {
      this.render({ type: "event", level: "info", message: `run ${this.name} started, ${this.agent}` });
      return;
    }
    if (this.hidden(event)) return;
    this.render(event);
    if (event.type !== "run") return;
    if (event.phase === "done") {
      const line = resultLine(event.result);
      if (line !== undefined) this.write(`${line}\n`);
      this.finish(0);
    }
    if (event.phase === "stopped") {
      this.write(`run ${this.name} stopped\n`);
      this.finish(130);
    }
    if (event.phase === "error") {
      this.write(`run ${this.name} failed: ${event.reason ?? "unknown error"}\n`);
      this.finish(1);
    }
  }

  private finish(code: number): void {
    this.ended = code;
    this.onEnd(code);
  }

  private hidden(event: ViewEvent): boolean {
    if (this.selected === undefined) return false;
    if (event.type !== "agent") return false;
    return this.sessions.get(event.session) !== this.selected;
  }

  private render(event: ViewEvent): void {
    try {
      this.renderer.render(event);
    } catch (error) {
      process.stderr.write(`wa: the view adapter failed: ${messageOf(error)}\n`);
    }
  }

  private flush(): void {
    const held = this.held;
    this.held = [];
    for (const event of held) this.show(event);
  }

  private prompt(): void {
    this.write(`\r\x1b[2K> ${this.buffer}`);
  }

  private erasePrompt(): void {
    this.write("\r\x1b[2K");
  }

  private write(text: string): void {
    if (!this.tty && text.startsWith("\r")) return;
    process.stdout.write(text);
  }
}

function resultLine(result: unknown): string | undefined {
  if (result === undefined) return undefined;
  return typeof result === "string" ? result : JSON.stringify(result);
}

function started(dir: string, pid: number): Promise<boolean> {
  const deadline = Date.now() + START_TIMEOUT;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (fs.existsSync(eventsPath(dir))) return resolve(true);
      if (!alive(pid)) return resolve(false);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 30);
    };
    tick();
  });
}

export function agentLine(found: adapters.Found[]): string {
  const picked = adapters.pick(found, "agent");
  return "found" in picked ? `agent ${picked.found.name}` : "no agent adapter is installed";
}

function build(found: adapters.Found[], cwd: string): ViewAdapter {
  const picked = adapters.pick(found, "view");
  if (!("found" in picked)) return plainRenderer();
  try {
    return picked.found.definition.build(host(cwd)) as ViewAdapter;
  } catch (error) {
    process.stderr.write(`wa: the view adapter failed to build: ${messageOf(error)}\n`);
    return plainRenderer();
  }
}

function host(cwd: string): Host {
  const at = (relative: string | undefined): string => path.resolve(cwd, relative ?? ".");
  return {
    cwd,
    shell: (cmd, options) => runCommand(cmd, at(options?.cwd), { stdin: options?.stdin }),
    exec: (argv, options) => runArgv(argv, at(options?.cwd), options),
    wait: (_label, body) => body(),
    emit: () => {},
  };
}
