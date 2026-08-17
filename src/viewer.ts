import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import * as adapters from "./adapters.ts";
import { pasteImage } from "./clipboard.ts";
import { readRun } from "./create.ts";
import * as credentials from "./credentials.ts";
import { Editor, Field, type Key } from "./editor.ts";
import { messageOf, PenguinError } from "./errors.ts";
import { Tail } from "./follow.ts";
import { alive, holder } from "./lock.ts";
import { attachmentsDir, credentialFile, eventsPath, inboxPath, runDir } from "./paths.ts";
import { control, entry, interactive } from "./prompt.ts";
import { edit, runArgv, runCommand } from "./spawn.ts";
import type { Host, ViewAdapter, ViewEvent } from "./types.ts";
import { plainRenderer } from "./view.ts";

const START_TIMEOUT = 10_000;
const WATCH = 500;
const HINT = "enter sends, esc clears, ctrl-v pastes an image";

type Keys = { start(): void; stop(): void };

type GateEvent = Extract<ViewEvent, { type: "gate" }>;

type CredentialEvent = Extract<ViewEvent, { type: "credential" }>;

type Asked = Extract<CredentialEvent, { phase: "asked" }>;

type Rejected = Extract<CredentialEvent, { phase: "rejected" }>;

type Fix = "retry" | "reset" | "edit" | "stop";

export type GateControl = { list: string[]; many: boolean } | { hint: string | undefined };

export async function attach(name: string, pid?: number): Promise<number> {
  const dir = runDir(name);
  if (!fs.existsSync(dir)) throw new PenguinError(`no run named ${name}`);
  const record = readRun(dir);
  const found = await adapters.installed(record.cwd);
  const viewer = new Viewer(name, dir, build(found, record.cwd), agentLine(found));
  if (pid !== undefined && !(await started(dir, pid))) {
    process.stderr.write(`pn: the run process for ${name} died before it started\n`);
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
      process.stderr.write("pn: the run process died\n");
      finish(1);
    }, WATCH);
    const keys = interactive() ? keyboard(viewer, finish) : undefined;
    if (keys !== undefined) viewer.live(keys);
    tail.follow();
  });
}

function keyboard(viewer: Viewer, finish: (code: number) => void): Keys {
  const input = process.stdin;
  const onKey = (text: string | undefined, key: Key): void => {
    if (key.ctrl === true && key.name === "c" && !viewer.busy()) {
      viewer.stopRun();
      return;
    }
    if (!viewer.typing()) {
      if (key.name === "q") {
        finish(0);
        return;
      }
      if (key.name === "tab") {
        viewer.cycle();
        return;
      }
    }
    viewer.key(text, key);
  };
  return {
    start(): void {
      readline.emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      process.stdout.write("\x1b[?2004h");
      input.on("keypress", onKey);
    },
    stop(): void {
      process.stdout.write("\x1b[?2004l");
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
  private editor = new Editor();
  private field: Field | undefined;
  private held: ViewEvent[] = [];
  private ended: number | undefined;
  private keys: Keys | undefined;
  private control: { cancel(): void } | undefined;
  private pending: { question: string; list: string[]; many: boolean } | undefined;
  private wanted: Asked | undefined;
  private refused: Rejected | undefined;
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
    if (!this.editor.empty || this.control !== undefined) {
      this.held.push(event);
      if (event.type === "gate" && event.phase === "answered") this.control?.cancel();
      if (event.type === "credential" && event.phase === "ready") this.control?.cancel();
      return;
    }
    this.show(event);
  }

  live(keys: Keys): void {
    this.keys = keys;
    this.field = new Field(process.stdout, this.editor, HINT);
    keys.start();
    process.stdout.on("resize", this.redraw);
    void this.open();
  }

  code(): number | undefined {
    return this.ended;
  }

  typing(): boolean {
    return !this.editor.empty;
  }

  busy(): boolean {
    return this.editor.busy;
  }

  key(text: string | undefined, key: Key): void {
    const act = this.editor.key(text, key);
    if (act === "send") {
      const message = this.editor.take();
      this.field?.erase();
      this.deliver(message);
      this.flush();
      return;
    }
    if (act === "image") {
      void this.attach();
      return;
    }
    if (act !== "changed") return;
    if (this.editor.empty) {
      this.field?.erase();
      this.flush();
    } else {
      this.field?.draw();
    }
  }

  close(): void {
    this.closed = true;
    this.control?.cancel();
    this.control = undefined;
    this.editor.take();
    this.field?.erase();
    process.stdout.off("resize", this.redraw);
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

  private provide(name: string): void {
    const notice = { at: new Date().toISOString(), credential: name };
    fs.appendFileSync(inboxPath(this.dir), `${JSON.stringify(notice)}\n`);
  }

  private async open(): Promise<void> {
    if (this.keys === undefined || this.control !== undefined) return;
    const gate = this.pending;
    if (gate !== undefined) return this.openGate(gate);
    const refused = this.refused;
    if (refused !== undefined) return this.openFix(refused);
    const wanted = this.wanted;
    if (wanted !== undefined) return this.openEntry(wanted);
  }

  private async openGate(gate: { question: string; list: string[]; many: boolean }): Promise<void> {
    const keys = this.keys as Keys;
    keys.stop();
    const running = control(
      gate.question,
      gate.list.map((label) => ({ label })),
      { many: gate.many, interrupt: () => this.stopRun() },
    );
    this.control = running;
    const picked = await running.picked;
    this.control = undefined;
    this.pending = undefined;
    if (this.closed) return;
    keys.start();
    if (picked !== undefined && picked.length > 0) {
      this.deliver(picked.map((index) => gate.list[index] ?? "").join(", "));
    }
    this.flush();
    void this.open();
  }

  /** The credential goes straight to the store. The run hears only that the store has it. */
  private async openEntry(wanted: Asked): Promise<void> {
    const keys = this.keys as Keys;
    keys.stop();
    const running = entry(`${wanted.label} needs a credential`, notes(wanted), wanted.fields, {
      interrupt: () => this.stopRun(),
    });
    this.control = running;
    const taken = await running.taken;
    this.control = undefined;
    if (this.closed) return;
    keys.start();
    if (taken !== undefined) {
      this.wanted = undefined;
      credentials.save(wanted.name, taken);
      this.provide(wanted.name);
    }
    this.flush();
    void this.open();
  }

  /** The provider said no. The user picks the fix, and the run hears only that it is done. */
  private async openFix(refused: Rejected): Promise<void> {
    const keys = this.keys as Keys;
    keys.stop();
    const list = fixes(refused.name);
    const running = control(`${refused.label} refused the credential. What now?`, list, {
      many: false,
      interrupt: () => this.stopRun(),
      notes: why(refused),
    });
    this.control = running;
    const picked = await running.picked;
    const fix = picked === undefined ? undefined : list[picked[0] ?? 0]?.fix;
    if (fix === "edit") await this.editStore(refused);
    this.control = undefined;
    if (this.closed) return;
    keys.start();
    this.refused = undefined;
    if (fix === "reset") {
      credentials.forget(refused.name);
      this.wanted = {
        type: "credential",
        phase: "asked",
        name: refused.name,
        label: refused.label,
        url: refused.url,
        hint: refused.hint,
        fields: refused.fields,
      };
    } else if (fix === "stop") {
      this.stopRun();
    } else if (fix !== undefined) {
      this.provide(refused.name);
    }
    this.flush();
    void this.open();
  }

  private async editStore(refused: Rejected): Promise<void> {
    credentials.seed(
      refused.name,
      refused.fields.map((field) => field.name),
    );
    await edit(credentialFile(refused.name));
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

  private credentialed(event: CredentialEvent): void {
    if (event.phase === "ready") {
      this.wanted = undefined;
      this.refused = undefined;
      return;
    }
    if (event.phase === "rejected") this.refused = event;
    else this.wanted = event;
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
    if (event.type === "credential") this.credentialed(event);
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
      process.stderr.write(`pn: the view adapter failed: ${messageOf(error)}\n`);
    }
  }

  private flush(): void {
    const held = this.held;
    this.held = [];
    for (const event of held) this.show(event);
  }

  private redraw = (): void => {
    if (!this.editor.empty) this.field?.draw();
  };

  private async attach(): Promise<void> {
    const got = await pasteImage(attachmentsDir(this.dir));
    if (this.closed) return;
    if ("path" in got) {
      this.editor.insert(got.path);
      this.field?.draw();
    } else {
      this.field?.note(got.warn);
    }
  }

  private write(text: string): void {
    if (!this.tty && text.startsWith("\r")) return;
    process.stdout.write(text);
  }
}

export function fixes(name: string): { label: string; note?: string; fix: Fix }[] {
  return [
    { label: "try again", note: "use the values penguin has", fix: "retry" },
    { label: "enter it again", note: "type each value again", fix: "reset" },
    { label: "edit the file", note: `open ${credentials.where(name)}`, fix: "edit" },
    { label: "stop the run", fix: "stop" },
  ];
}

export function why(refused: Rejected): string[] {
  const lines = [refused.reason];
  if (refused.where !== "") lines.push(`penguin read it from ${refused.where}`);
  return lines;
}

export function notes(asked: Asked): string[] {
  const lines: string[] = [];
  if (asked.url !== undefined) lines.push(`make one at ${asked.url}`);
  if (asked.hint !== undefined) lines.push(asked.hint);
  const vars = asked.fields.map((field) => field.env).filter((name) => name !== undefined);
  if (vars.length > 0) lines.push(`or set ${vars.join(", ")} in your environment`);
  lines.push(`penguin keeps it in ${credentials.where(asked.name)}, readable by you alone`);
  return lines;
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
    process.stderr.write(`pn: the view adapter failed to build: ${messageOf(error)}\n`);
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
    credential: () => {
      throw new PenguinError("a view adapter cannot ask for a credential");
    },
  };
}
