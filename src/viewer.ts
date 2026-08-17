import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import * as adapters from "./adapters.ts";
import { readRun } from "./create.ts";
import { messageOf, PenguinError } from "./errors.ts";
import { Tail } from "./follow.ts";
import { alive, holder } from "./lock.ts";
import { eventsPath, inboxPath, runDir } from "./paths.ts";
import { type Control, control, interactive } from "./prompt.ts";
import { runArgv, runCommand } from "./spawn.ts";
import type { Host, ViewAdapter, ViewEvent } from "./types.ts";
import { plainRenderer } from "./view.ts";

const START_TIMEOUT = 10_000;
const WATCH = 500;

type Keys = { start(): void; stop(): void };

type GateEvent = Extract<ViewEvent, { type: "gate" }>;

export type GateControl = { list: string[]; many: boolean } | { hint: string | undefined };

export async function attach(name: string, pid?: number): Promise<number> {
  const dir = runDir(name);
  if (!fs.existsSync(dir)) throw new PenguinError(`no run named ${name}`);
  const record = readRun(dir);
  const found = await adapters.installed(record.cwd);
  const viewer = new Viewer(name, dir, build(found, record.cwd), agentLine(found));
  if (pid !== undefined && !(await started(dir, pid))) {
    process.stderr.write(`penguin: the run process for ${name} died before it started\n`);
    return 1;
  }
  const tail = new Tail(eventsPath(dir), (line) => viewer.line(line));
  tail.read();
  const live = holder(dir) !== undefined;
  if (!live) tail.read();
  const code = viewer.code();
  if (code !== undefined) return code;
  if (!live) return 0;
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
      viewer.close();
      keys?.stop();
      resolve(code);
    };
    viewer.onEnd = finish;
    const watchdog = setInterval(() => {
      if (holder(dir) !== undefined) return;
      tail.read();
      if (settled) return;
      process.stderr.write("penguin: the run process died\n");
      finish(1);
    }, WATCH);
    const keys = interactive() ? keyboard(viewer, finish) : undefined;
    if (keys !== undefined) viewer.live(keys);
    tail.follow();
  });
}

function keyboard(viewer: Viewer, finish: (code: number) => void): Keys {
  const input = process.stdin;
  const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean }): void => {
    if (key.ctrl === true && key.name === "c") {
      viewer.stopRun();
      return;
    }
    if (key.name === "tab") {
      viewer.cycle();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      viewer.send();
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
  return {
    start(): void {
      readline.emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      input.on("keypress", onKey);
    },
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
  private dir: string;
  private renderer: ViewAdapter;
  private agent: string;
  private tty = process.stdout.isTTY === true;
  private sessions = new Map<string, string>();
  private order: string[] = [];
  private selected: string | undefined;
  private buffer = "";
  private held: ViewEvent[] = [];
  private ended: number | undefined;
  private keys: Keys | undefined;
  private control: Control | undefined;
  private pending: { question: string; list: string[]; many: boolean } | undefined;
  private closed = false;

  constructor(name: string, dir: string, renderer: ViewAdapter, agent: string) {
    this.name = name;
    this.dir = dir;
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
      this.close();
      this.show(event);
      return;
    }
    if (this.buffer !== "" || this.control !== undefined) {
      this.held.push(event);
      if (event.type === "gate" && event.phase === "answered") this.control?.cancel();
      return;
    }
    this.show(event);
  }

  live(keys: Keys): void {
    this.keys = keys;
    keys.start();
    void this.open();
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

  close(): void {
    this.closed = true;
    this.control?.cancel();
    this.control = undefined;
    this.clear();
    this.flush();
  }

  send(): void {
    const text = this.buffer;
    if (text === "") return;
    this.buffer = "";
    this.erasePrompt();
    this.deliver(text);
    this.flush();
  }

  cycle(): void {
    const names = [undefined, ...this.order];
    const next = names[(names.indexOf(this.selected) + 1) % names.length];
    this.selected = next;
    this.write(`viewing: ${next ?? "all"}\n`);
  }

  stopRun(): void {
    const pid = holder(this.dir);
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

  private deliver(text: string): void {
    const message = { at: new Date().toISOString(), text, session: this.selected };
    fs.appendFileSync(inboxPath(this.dir), `${JSON.stringify(message)}\n`);
  }

  private async open(): Promise<void> {
    const gate = this.pending;
    const keys = this.keys;
    if (gate === undefined || keys === undefined || this.control !== undefined) return;
    keys.stop();
    const running = control(
      gate.question,
      gate.list.map((label) => ({ label })),
      { many: gate.many, interrupt: () => this.stopRun() },
    );
    this.control = running;
    const picked = await running.picked;
    this.control = undefined;
    if (this.closed) return;
    keys.start();
    if (picked !== undefined && picked.length > 0) {
      this.deliver(picked.map((index) => gate.list[index] ?? "").join(", "));
    }
    this.flush();
  }

  private gated(event: GateEvent): void {
    this.pending = undefined;
    if (event.phase !== "asked" || event.schema === undefined) return;
    const shape = controlFor(event.schema);
    if ("hint" in shape) {
      if (this.tty && shape.hint !== undefined) this.write(`expects: ${shape.hint}\n`);
      return;
    }
    this.pending = { question: event.question, list: shape.list, many: shape.many };
    void this.open();
  }

  private show(event: ViewEvent): void {
    if (event.type === "run" && event.phase === "started") {
      this.render({ type: "event", level: "info", message: `run ${this.name} started, ${this.agent}` });
      return;
    }
    if (this.hidden(event)) return;
    this.render(event);
    if (event.type === "gate") this.gated(event);
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
      process.stderr.write(`penguin: the view adapter failed: ${messageOf(error)}\n`);
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

export function controlFor(schema: Record<string, unknown>): GateControl {
  const labels = enumOf(schema);
  if (labels !== undefined) return { list: labels, many: false };
  if (schema["type"] === "array") {
    const items = enumOf(schema["items"]);
    if (items !== undefined) return { list: items, many: true };
  }
  if (schema["type"] === "boolean") return { list: ["yes", "no"], many: false };
  return { hint: hintOf(schema) };
}

function enumOf(schema: unknown): string[] | undefined {
  if (schema === null || typeof schema !== "object") return undefined;
  const values = (schema as { enum?: unknown }).enum;
  if (!Array.isArray(values) || values.length === 0) return undefined;
  if (values.some((value) => typeof value !== "string")) return undefined;
  return values as string[];
}

function hintOf(schema: Record<string, unknown>): string | undefined {
  const format = schema["format"];
  if (typeof format === "string") return format === "uri" ? "url" : format;
  const type = schema["type"];
  return typeof type === "string" ? type : undefined;
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
    process.stderr.write(`penguin: the view adapter failed to build: ${messageOf(error)}\n`);
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
