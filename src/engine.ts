import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import * as adapters from "./adapters.ts";
import { readRun, type RunRecord } from "./create.ts";
import { messageOf, WaError } from "./errors.ts";
import { Tail } from "./follow.ts";
import { acquire } from "./lock.ts";
import { load } from "./loader.ts";
import { inboxPath, runDir, transcriptsDir } from "./paths.ts";
import { resolve as resolveSkill } from "./skills.ts";
import { type Children, children, inScope, kill, killActive, runArgv, runCommand } from "./spawn.ts";
import {
  type AgentAdapter,
  type AgentOptions,
  type AgentRunOptions,
  type AgentSession,
  type AgentTurnResult,
  COMPOSE,
  type Ctx,
  type Host,
  type Message,
  type Turn,
  type View,
  type ViewEvent,
  type Workflow,
} from "./types.ts";
import { Bus } from "./view.ts";

export async function execute(name: string): Promise<number> {
  const dir = runDir(name);
  const record = readRun(dir);
  const release = acquire(dir);
  const bus = new Bus(dir);
  let execution: Execution | undefined;
  let ending = false;
  const onSignal = (): void => {
    if (ending) return;
    ending = true;
    execution?.close();
    killActive();
    bus.emit({ type: "run", phase: "stopped", run: name });
    release();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  bus.emit({ type: "run", phase: "started", run: name });
  try {
    const definition = await load(record.workflow);
    const params = definition.params.parse(record.params);
    const found = await adapters.installed(record.cwd);
    execution = new Execution(dir, record, found, bus);
    execution.open();
    const result = await runner(definition)(execution.ctx(params));
    execution.close();
    bus.emit({ type: "run", phase: "done", run: name, result });
    return 0;
  } catch (error) {
    execution?.close();
    bus.emit({ type: "run", phase: "error", run: name, reason: messageOf(error) });
    return 1;
  } finally {
    release();
  }
}

function runner(definition: Workflow): (ctx: Ctx<unknown>) => Promise<unknown> {
  return definition.run as (ctx: Ctx<unknown>) => Promise<unknown>;
}

type ActivityStore = { id: string };

type Reader = { question: string | undefined; resolve(message: Message): void };

type Wait = { label: string };

type State = { state: "running" | "blocked" | "idle"; detail: string | undefined };

type TurnCall = {
  session: string;
  api: AgentAdapter;
  cwd: string;
  options: Record<string, unknown>;
  skill: string;
  input: string | undefined;
  result: z.ZodObject | undefined;
  first: () => boolean;
  bump: () => void;
};

class Execution {
  private dir: string;
  private record: RunRecord;
  private found: adapters.Found[];
  private bus: Bus;
  private als = new AsyncLocalStorage<ActivityStore>();
  private built = new Map<string, unknown>();
  private counter = 0;
  private activityCounter = 0;
  private named = new Map<string, number>();
  private steps = 0;
  private waits: Wait[] = [];
  private readers: Reader[] = [];
  private queued: Message[] = [];
  private inbox: Tail | undefined;
  private state = "";

  constructor(dir: string, record: RunRecord, found: adapters.Found[], bus: Bus) {
    this.dir = dir;
    this.record = record;
    this.found = found;
    this.bus = bus;
  }

  open(): void {
    this.inbox = new Tail(inboxPath(this.dir), (line) => this.ingest(line));
    this.inbox.follow();
  }

  close(): void {
    this.inbox?.stop();
    this.inbox = undefined;
    killActive();
  }

  ctx<Params>(params: Params): Ctx<Params> {
    const roles = new Set(
      this.found.map((entry) => entry.role).filter((role) => role !== "agent" && role !== "view"),
    );
    const base: Record<string, unknown> = {
      params,
      gate: (question: string) => this.gate(question),
      messages: { next: () => this.read().message },
      view: this.view(),
      agent: (options?: AgentOptions) => this.session(options ?? {}),
    };
    const cached = new Map<string, unknown>();
    const target = base as unknown as Ctx<Params>;
    return new Proxy(target, {
      get: (_, prop) => {
        if (prop === COMPOSE) {
          return (definition: Workflow, args: unknown) => this.compose(definition, args);
        }
        if (typeof prop !== "string") return undefined;
        if (prop in base) return base[prop];
        if (roles.has(prop)) {
          const ready = cached.get(prop);
          if (ready !== undefined) return ready;
          const built = this.role(prop);
          cached.set(prop, built);
          return built;
        }
        throw new WaError(
          `nothing provides ctx.${prop}. Installed adapter roles: ${[...roles, "agent", "view"].sort().join(", ")}. Adapters are files in ${adapters.searched(this.record.cwd).join(" and ")}.`,
        );
      },
    });
  }

  private async compose(definition: Workflow, args: unknown): Promise<unknown> {
    const checked = definition.params.safeParse(args);
    if (!checked.success) {
      throw new WaError(
        `invalid params for the workflow "${definition.description}": ${issues(checked.error)}`,
      );
    }
    return this.activity(definition.description, () => runner(definition)(this.ctx(checked.data)));
  }

  private view(): View {
    return {
      activity: <T>(label: string, body: () => Promise<T>): Promise<T> => this.activity(label, body),
      fact: (values) => this.bus.emit({ type: "fact", values }),
      event: (entry) =>
        this.bus.emit({
          type: "event",
          level: entry.level ?? "info",
          message: entry.message,
          data: entry.data,
          activity: this.als.getStore()?.id,
        }),
      artifact: (entry) => this.bus.emit({ type: "artifact", ...entry }),
      watch: (readouts) => this.bus.emit({ type: "watch", ...readouts }),
    };
  }

  private async activity<T>(label: string, body: () => Promise<T>): Promise<T> {
    const id = `a${this.activityCounter++}`;
    const parent = this.als.getStore()?.id;
    this.bus.emit({ type: "activity", phase: "start", id, parent, label });
    try {
      const value = await this.als.run({ id }, body);
      this.bus.emit({ type: "activity", phase: "end", id, outcome: "ok" });
      return value;
    } catch (error) {
      this.bus.emit({ type: "activity", phase: "end", id, outcome: "failed" });
      throw error;
    }
  }

  private role(role: string): unknown {
    const picked = adapters.pick(this.found, role);
    if ("missing" in picked) throw new WaError(picked.missing);
    if ("conflict" in picked) throw new WaError(picked.conflict);
    return this.wrap(role, this.build(picked.found, this.host()));
  }

  private build(entry: adapters.Found, host: Host): unknown {
    const key = `${entry.role}\n${entry.name}`;
    const ready = this.built.get(key);
    if (ready !== undefined) return ready;
    const api = entry.definition.build(host);
    this.built.set(key, api);
    return api;
  }

  private wrap(role: string, api: unknown, prefix = ""): unknown {
    if (api === null || typeof api !== "object") return api;
    const wrapped: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(api)) {
      const method = prefix === "" ? name : `${prefix}.${name}`;
      if (typeof value === "function") {
        wrapped[name] = (...args: unknown[]) =>
          this.adapterCall(role, method, value as (...args: unknown[]) => unknown, args);
      } else if (value !== null && typeof value === "object") {
        wrapped[name] = this.wrap(role, value, method);
      } else {
        wrapped[name] = value;
      }
    }
    return wrapped;
  }

  private async adapterCall(
    role: string,
    method: string,
    fn: (...args: unknown[]) => unknown,
    args: unknown[],
  ): Promise<unknown> {
    const id = this.nextId();
    const label = `${role}.${method}`;
    const activity = this.als.getStore()?.id;
    this.bus.emit({ type: "step", phase: "start", id, label, activity });
    this.begin();
    try {
      const value = (await fn(...args)) ?? null;
      this.bus.emit({ type: "step", phase: "end", id, label, ok: true, activity });
      return value;
    } catch (error) {
      this.bus.emit({ type: "step", phase: "end", id, label, ok: false, activity });
      throw error;
    } finally {
      this.end();
    }
  }

  private session(options: AgentOptions): AgentSession {
    const { use, cwd, name, ...rest } = options;
    const picked = adapters.pick(this.found, "agent", use);
    if ("missing" in picked) throw new WaError(picked.missing);
    if ("conflict" in picked) throw new WaError(picked.conflict);
    const id = crypto.randomUUID();
    const label = name === undefined || name === "" ? this.sessionName(picked.found.name) : name;
    this.bus.emit({ type: "session", id, name: label, use: picked.found.name });
    const api = this.build(picked.found, this.agentHost()) as AgentAdapter;
    let attempts = 0;
    const run = (skill: string, runOptions?: AgentRunOptions & { result?: z.ZodObject }) =>
      this.turn({
        session: id,
        api,
        cwd: this.resolveCwd(cwd),
        options: rest,
        skill,
        input: runOptions?.input,
        result: runOptions?.result,
        first: () => attempts === 0,
        bump: () => {
          attempts += 1;
        },
      });
    return { run } as AgentSession;
  }

  private sessionName(use: string): string {
    const n = (this.named.get(use) ?? 0) + 1;
    this.named.set(use, n);
    return `${use}-${n}`;
  }

  private turn(call: TurnCall): Turn<unknown> {
    const set = children();
    let stopped = false;
    let halt = (): void => {};
    const halted = new Promise<void>((resolve) => {
      halt = resolve;
    });
    const dispatched = this.dispatch(call, set, () => stopped, halted);
    const stop = async (): Promise<void> => {
      stopped = true;
      halt();
      kill(set);
      await dispatched.then(
        () => {},
        () => {},
      );
    };
    return Object.assign(dispatched, { stop });
  }

  private async dispatch(
    call: TurnCall,
    set: Children,
    stopped: () => boolean,
    halted: Promise<void>,
  ): Promise<unknown> {
    const id = this.nextId();
    const found = resolveSkill(call.skill, this.record.workflow, this.record.cwd);
    if (found.file === undefined) {
      throw new WaError(`no skill ${call.skill}. Looked in ${found.searched.join(", ")}`);
    }
    const skillText = fs.readFileSync(found.file, "utf8");
    let schema: Record<string, unknown> | undefined;
    if (call.result !== undefined) {
      schema = z.toJSONSchema(call.result) as Record<string, unknown>;
      delete schema["$schema"];
    }
    const label = `agent ${call.skill}`;
    const activity = this.als.getStore()?.id;
    this.bus.emit({ type: "step", phase: "start", id, label, activity });
    this.begin();
    try {
      for (let round = 0; ; round++) {
        let failure: string | undefined;
        for (let tries = 0; tries < 2; tries++) {
          const prompt = composePrompt(skillText, call.input, failure);
          this.transcribe(call.session, `\n>>> ${call.skill}\n\n${prompt}\n`);
          const first = call.first();
          call.bump();
          let outcome: AgentTurnResult;
          try {
            outcome = await inScope(set, () =>
              call.api.turn({
                session: call.session,
                first,
                cwd: call.cwd,
                prompt,
                schema,
                options: call.options,
              }),
            );
          } catch (error) {
            if (!stopped()) throw error;
            return this.endStep(id, label, activity, false, undefined);
          }
          if (stopped()) return this.endStep(id, label, activity, false, undefined);
          if (outcome.ok) {
            if (call.result === undefined) return this.endStep(id, label, activity, true, null);
            const checked = call.result.safeParse(outcome.value);
            if (checked.success) {
              return this.endStep(id, label, activity, true, checked.data);
            }
            failure = issues(checked.error);
          } else {
            failure = outcome.error;
          }
          this.bus.emit({
            type: "event",
            level: "warn",
            message: `step ${id} failed: ${failure}`,
            activity,
          });
        }
        const answer = await this.paused(() =>
          this.gateUntil(
            `The agent step ${call.skill} failed twice: ${failure} Reply to run the step again.`,
            halted,
          ),
        );
        if (answer === undefined) return this.endStep(id, label, activity, false, undefined);
      }
    } finally {
      this.end();
    }
  }

  private endStep(
    id: string,
    label: string,
    activity: string | undefined,
    ok: boolean,
    value: unknown,
  ): unknown {
    this.bus.emit({ type: "step", phase: "end", id, label, ok, activity });
    return value;
  }

  private async paused<T>(body: () => Promise<T>): Promise<T> {
    this.end();
    try {
      return await body();
    } finally {
      this.begin();
    }
  }

  private async gate(question: string): Promise<string> {
    this.bus.emit({ type: "gate", phase: "asked", question });
    const { message } = this.read(question);
    return this.answered(question, await message);
  }

  private async gateUntil(question: string, halted: Promise<void>): Promise<string | undefined> {
    this.bus.emit({ type: "gate", phase: "asked", question });
    const reader = this.read(question);
    const message = await Promise.race([reader.message, halted.then(() => undefined)]);
    if (message === undefined) {
      reader.cancel();
      return undefined;
    }
    return this.answered(question, message);
  }

  private answered(question: string, message: Message): string {
    this.bus.emit({ type: "gate", phase: "answered", question, answer: message.text });
    return message.text;
  }

  private read(question?: string): { message: Promise<Message>; cancel(): void } {
    const queued = this.queued.shift();
    if (queued !== undefined) {
      return { message: Promise.resolve(queued), cancel: () => {} };
    }
    let settle: (message: Message) => void = () => {};
    const message = new Promise<Message>((resolve) => {
      settle = resolve;
    });
    const reader: Reader = { question, resolve: settle };
    this.readers.push(reader);
    this.refresh();
    return {
      message,
      cancel: () => {
        const index = this.readers.indexOf(reader);
        if (index === -1) return;
        this.readers.splice(index, 1);
        this.refresh();
      },
    };
  }

  private ingest(line: string): void {
    let parsed: { text?: unknown; session?: unknown };
    try {
      parsed = JSON.parse(line) as { text?: unknown; session?: unknown };
    } catch {
      return;
    }
    if (typeof parsed.text !== "string") return;
    const message: Message = {
      text: parsed.text,
      session: typeof parsed.session === "string" ? parsed.session : undefined,
    };
    this.bus.emit({ type: "message", text: message.text, session: message.session });
    const reader = this.readers.shift();
    if (reader === undefined) this.queued.push(message);
    else reader.resolve(message);
    this.refresh();
  }

  private begin(): void {
    this.steps += 1;
    this.refresh();
  }

  private end(): void {
    this.steps -= 1;
    this.refresh();
  }

  private refresh(): void {
    const next = this.stateNow();
    const key = `${next.state}\n${next.detail ?? ""}`;
    if (key === this.state) return;
    this.state = key;
    this.bus.emit({ type: "state", state: next.state, detail: next.detail });
  }

  private stateNow(): State {
    if (this.steps > this.waits.length) return { state: "running", detail: undefined };
    const reader = this.readers[0];
    if (reader !== undefined) return { state: "blocked", detail: reader.question };
    const wait = this.waits[0];
    if (wait !== undefined) return { state: "idle", detail: wait.label };
    return { state: "running", detail: undefined };
  }

  private host(): Host {
    return {
      cwd: this.record.cwd,
      shell: (cmd, options) =>
        runCommand(cmd, this.resolveCwd(options?.cwd), { stdin: options?.stdin }),
      exec: (argv, options) => runArgv(argv, this.resolveCwd(options?.cwd), options),
      wait: <T>(label: string, body: () => Promise<T>): Promise<T> => this.wait(label, body),
      emit: (event: ViewEvent) => this.bus.emit(event),
    };
  }

  private agentHost(): Host {
    const base = this.host();
    return {
      ...base,
      emit: (event) => {
        if (event.type === "agent") {
          this.transcribe(event.session, event.kind === "output" ? event.text : `${event.text}\n`);
        }
        base.emit(event);
      },
    };
  }

  private async wait<T>(label: string, body: () => Promise<T>): Promise<T> {
    const entry: Wait = { label };
    this.waits.push(entry);
    this.refresh();
    try {
      return await body();
    } finally {
      const index = this.waits.indexOf(entry);
      if (index !== -1) this.waits.splice(index, 1);
      this.refresh();
    }
  }

  private transcribe(session: string, text: string): void {
    const dir = transcriptsDir(this.dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${session}.txt`), text);
  }

  private resolveCwd(relative: string | undefined): string {
    return path.resolve(this.record.cwd, relative ?? ".");
  }

  private nextId(): string {
    const id = String(this.counter);
    this.counter += 1;
    return id;
  }
}

function composePrompt(skillText: string, input: string | undefined, failure: string | undefined): string {
  const parts = [skillText.trim()];
  if (input !== undefined && input !== "") parts.push(`# Input\n\n${input}`);
  if (failure !== undefined) {
    parts.push(`# Correction\n\nThe last attempt failed: ${failure}\nDo the step again and fix that.`);
  }
  return `${parts.join("\n\n")}\n`;
}

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.join(".");
      return at === "" ? issue.message : `${at}: ${issue.message}`;
    })
    .join("; ");
}
