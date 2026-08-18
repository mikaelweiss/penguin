import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import * as adapters from "./adapters.ts";
import { readRun, type RunRecord } from "./create.ts";
import * as credentials from "./credentials.ts";
import { messageOf, PenguinError } from "./errors.ts";
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
  type CredentialField,
  type CredentialRequest,
  type Ctx,
  type Host,
  type Message,
  type Turn,
  type View,
  type ViewEvent,
  type Workflow,
} from "./types.ts";
import { Bus } from "./bus.ts";

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

type Reader = { question: string | undefined; gate: string | undefined; resolve(message: Message): void };

type Step = { id: string; label: string; paused: boolean };

type Wait = { label: string };

type Want = { name: string; label: string; resolve(): void };

type State = { state: "running" | "blocked" | "idle"; detail: string | undefined };

type TurnCall = {
  session: string;
  api: AgentAdapter;
  cwd: string;
  options: Record<string, unknown>;
  skill: string;
  input: string | undefined;
  result: z.ZodObject | undefined;
  blocked: z.ZodObject | undefined;
  first: () => boolean;
  bump: () => void;
};

/** The event types that carry a position in the activity tree. */
const placed = new Set(["session", "agent", "gate", "step", "event", "wait"]);

class Execution {
  private dir: string;
  private record: RunRecord;
  private found: adapters.Found[];
  private bus: Bus;
  private als = new AsyncLocalStorage<ActivityStore>();
  private built = new Map<string, unknown>();
  private counter = 0;
  private activityCounter = 0;
  private gateCounter = 0;
  private waitCounter = 0;
  private named = new Map<string, number>();
  private steps: Step[] = [];
  private waits: Wait[] = [];
  private wants: Want[] = [];
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

  /** Every event leaves the engine here, stamped with the activity it happened in. */
  private emit(event: ViewEvent): void {
    this.bus.emit(placed.has(event.type) ? this.place(event) : event);
  }

  private place(event: ViewEvent): ViewEvent {
    const carrier = event as ViewEvent & { activity?: string };
    if (carrier.activity !== undefined) return event;
    const activity = this.als.getStore()?.id;
    if (activity === undefined) return event;
    return { ...carrier, activity } as ViewEvent;
  }

  ctx<Params>(params: Params): Ctx<Params> {
    const roles = new Set(
      this.found.map((entry) => entry.role).filter((role) => role !== "agent"),
    );
    const base: Record<string, unknown> = {
      params,
      gate: (question: string, shape?: z.ZodType) => this.gate(question, shape),
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
        throw new PenguinError(
          `nothing provides ctx.${prop}. Installed adapter roles: ${[...roles, "agent"].sort().join(", ")}. Adapters are files in ${adapters.searched(this.record.cwd).join(" and ")}.`,
        );
      },
    });
  }

  private async compose(definition: Workflow, args: unknown): Promise<unknown> {
    const checked = definition.params.safeParse(args);
    if (!checked.success) {
      throw new PenguinError(
        `invalid params for the workflow "${definition.description}": ${issues(checked.error)}`,
      );
    }
    return this.activity(
      definition.description,
      () => runner(definition)(this.ctx(checked.data)),
      summary(checked.data),
    );
  }

  private view(): View {
    return {
      activity: <T>(label: string, body: () => Promise<T>): Promise<T> => this.activity(label, body),
      fact: (values) => this.emit({ type: "fact", values }),
      event: (entry) =>
        this.emit({
          type: "event",
          level: entry.level ?? "info",
          message: entry.message,
          data: entry.data,
        }),
      artifact: (entry) => this.emit({ type: "artifact", ...entry }),
      watch: (readouts) => this.emit({ type: "watch", ...readouts }),
    };
  }

  private async activity<T>(label: string, body: () => Promise<T>, detail?: string): Promise<T> {
    const id = `a${this.activityCounter++}`;
    const parent = this.als.getStore()?.id;
    this.emit({ type: "activity", phase: "start", id, parent, label, detail });
    try {
      const value = await this.als.run({ id }, body);
      this.emit({ type: "activity", phase: "end", id, outcome: "ok" });
      return value;
    } catch (error) {
      this.emit({ type: "activity", phase: "end", id, outcome: "failed" });
      throw error;
    }
  }

  private role(role: string): unknown {
    const picked = adapters.pick(this.found, role);
    if ("missing" in picked) throw new PenguinError(picked.missing);
    if ("conflict" in picked) throw new PenguinError(picked.conflict);
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
    this.emit({ type: "step", phase: "start", id, label, activity });
    this.begin(id, label);
    try {
      const value = (await fn(...args)) ?? null;
      this.emit({ type: "step", phase: "end", id, label, ok: true, activity });
      return value;
    } catch (error) {
      this.emit({ type: "step", phase: "end", id, label, ok: false, activity });
      throw error;
    } finally {
      this.end(id);
    }
  }

  private session(options: AgentOptions): AgentSession {
    const { use, cwd, name, ...rest } = options;
    const picked = adapters.pick(this.found, "agent", use);
    if ("missing" in picked) throw new PenguinError(picked.missing);
    if ("conflict" in picked) throw new PenguinError(picked.conflict);
    const id = crypto.randomUUID();
    const label = name === undefined || name === "" ? this.sessionName(picked.found.name) : name;
    const dir = this.resolveCwd(cwd);
    this.emit({ type: "session", id, name: label, use: picked.found.name, dir });
    const api = this.build(picked.found, this.agentHost()) as AgentAdapter;
    let attempts = 0;
    const run = (
      skill: string,
      runOptions?: AgentRunOptions & { result?: z.ZodObject; blocked?: z.ZodObject },
    ) => {
      if (runOptions?.blocked !== undefined && runOptions.result === undefined) {
        throw new PenguinError("a turn with a blocked schema needs a result schema too");
      }
      return this.turn({
        session: id,
        api,
        cwd: dir,
        options: rest,
        skill,
        input: runOptions?.input,
        result: runOptions?.result,
        blocked: runOptions?.blocked,
        first: () => attempts === 0,
        bump: () => {
          attempts += 1;
        },
      });
    };
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
      throw new PenguinError(`no skill ${call.skill}. Looked in ${found.searched.join(", ")}`);
    }
    const skillText = fs.readFileSync(found.file, "utf8");
    const envelope = envelopeOf(call);
    const schema = turnSchema(call);
    const label = `agent ${call.skill}`;
    const activity = this.als.getStore()?.id;
    this.emit({ type: "step", phase: "start", id, label, activity });
    this.begin(id, label);
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
            if (envelope === undefined) return this.endStep(id, label, activity, true, null);
            const checked = envelope.safeParse(outcome.value);
            if (checked.success) {
              return this.endStep(id, label, activity, true, checked.data);
            }
            failure = issues(checked.error);
          } else {
            failure = outcome.error;
          }
          this.emit({
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
      this.end(id);
    }
  }

  private endStep(
    id: string,
    label: string,
    activity: string | undefined,
    ok: boolean,
    value: unknown,
  ): unknown {
    this.emit({ type: "step", phase: "end", id, label, ok, activity });
    return value;
  }

  /** The innermost step stops counting as running while it waits on the user. */
  private async paused<T>(body: () => Promise<T>): Promise<T> {
    const step = this.running().at(-1);
    if (step !== undefined) step.paused = true;
    this.refresh();
    try {
      return await body();
    } finally {
      if (step !== undefined) step.paused = false;
      this.refresh();
    }
  }

  private running(): Step[] {
    return this.steps.filter((step) => !step.paused);
  }

  private async gate(question: string, shape?: z.ZodType): Promise<unknown> {
    const id = this.nextGateId();
    const schema = shape === undefined ? undefined : jsonSchema(shape);
    for (;;) {
      this.emit({ type: "gate", phase: "asked", id, question, schema });
      const { message } = this.read(question, id);
      const answer = await message;
      if (shape === undefined) return this.answered(id, question, answer);
      const taken = coerce(shape, answer.text);
      if ("value" in taken) {
        this.answered(id, question, answer);
        return taken.value;
      }
      this.emit({
        type: "event",
        level: "warn",
        message: `the answer "${answer.text}" does not fit: ${taken.problem}`,
      });
    }
  }

  private async gateUntil(question: string, halted: Promise<void>): Promise<string | undefined> {
    const id = this.nextGateId();
    this.emit({ type: "gate", phase: "asked", id, question });
    const reader = this.read(question, id);
    const message = await Promise.race([reader.message, halted.then(() => undefined)]);
    if (message === undefined) {
      reader.cancel();
      return undefined;
    }
    return this.answered(id, question, message);
  }

  private answered(id: string, question: string, message: Message): string {
    this.emit({ type: "gate", phase: "answered", id, question, answer: message.text });
    return message.text;
  }

  private read(question?: string, gate?: string): { message: Promise<Message>; cancel(): void } {
    const queued = this.queued.shift();
    if (queued !== undefined) {
      return { message: Promise.resolve(queued), cancel: () => {} };
    }
    let settle: (message: Message) => void = () => {};
    const message = new Promise<Message>((resolve) => {
      settle = resolve;
    });
    const reader: Reader = { question, gate, resolve: settle };
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

  /**
   * The values an adapter needs from the user. A secret never travels as a message: a
   * viewer writes it to the credential store and says only that the store now holds it.
   */
  private async credential(request: CredentialRequest): Promise<Record<string, string>> {
    const rejected = request.rejected;
    if (rejected !== undefined) await this.paused(() => this.refused(request, rejected));
    for (;;) {
      const taken = this.take(request);
      if (taken.missing.length === 0) {
        this.emit({ type: "credential", phase: "ready", name: request.name, where: taken.where });
        return taken.values;
      }
      await this.paused(() => this.ask(request, taken.missing));
    }
  }

  private take(request: CredentialRequest): {
    values: Record<string, string>;
    missing: CredentialField[];
    where: string;
  } {
    const stored = credentials.read(request.name);
    const values: Record<string, string> = {};
    const missing: CredentialField[] = [];
    const places = new Set<string>();
    for (const field of request.fields) {
      const fromEnv = field.env === undefined ? undefined : process.env[field.env];
      if (fromEnv !== undefined && fromEnv !== "") {
        values[field.name] = fromEnv;
        places.add(`the environment`);
        continue;
      }
      const kept = stored[field.name];
      if (kept !== undefined) {
        values[field.name] = kept;
        places.add(credentials.where(request.name));
        continue;
      }
      missing.push(field);
    }
    return { values, missing, where: [...places].join(" and ") };
  }

  private ask(request: CredentialRequest, missing: CredentialField[]): Promise<void> {
    this.emit({
      type: "credential",
      phase: "asked",
      name: request.name,
      label: request.label,
      url: request.url,
      hint: request.hint,
      fields: missing.map(shownField),
    });
    return this.wanted(request.name, `${request.label} needs a credential`);
  }

  /** The provider refused what penguin had. A viewer offers the fixes and picks none itself. */
  private refused(request: CredentialRequest, reason: string): Promise<void> {
    this.emit({
      type: "credential",
      phase: "rejected",
      name: request.name,
      label: request.label,
      reason,
      where: this.take(request).where,
      url: request.url,
      hint: request.hint,
      fields: request.fields.map(shownField),
    });
    return this.wanted(request.name, `${request.label} refused the credential`);
  }

  private wanted(name: string, label: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wants.push({ name, label, resolve });
      this.refresh();
    });
  }

  private provided(name: string): void {
    const waiting = this.wants.filter((want) => want.name === name);
    this.wants = this.wants.filter((want) => want.name !== name);
    for (const want of waiting) want.resolve();
    this.refresh();
  }

  private ingest(line: string): void {
    type Line = { text?: unknown; session?: unknown; gate?: unknown; credential?: unknown };
    let parsed: Line;
    try {
      parsed = JSON.parse(line) as Line;
    } catch {
      return;
    }
    if (typeof parsed.credential === "string") {
      this.provided(parsed.credential);
      return;
    }
    if (typeof parsed.text !== "string") return;
    const message: Message = {
      text: parsed.text,
      session: typeof parsed.session === "string" ? parsed.session : undefined,
    };
    this.emit({ type: "message", text: message.text, session: message.session });
    const gate = typeof parsed.gate === "string" ? parsed.gate : undefined;
    const reader = this.pick(gate);
    if (reader === undefined) this.queued.push(message);
    else reader.resolve(message);
    this.refresh();
  }

  /**
   * The reader a message goes to: the one holding the gate it addresses, else the
   * earliest waiting reader. A gate no reader holds takes the unaddressed path.
   */
  private pick(gate: string | undefined): Reader | undefined {
    const addressed = gate === undefined ? -1 : this.readers.findIndex((one) => one.gate === gate);
    return this.readers.splice(addressed === -1 ? 0 : addressed, 1)[0];
  }

  private begin(id: string, label: string): void {
    this.steps.push({ id, label, paused: false });
    this.refresh();
  }

  private end(id: string): void {
    const index = this.steps.findIndex((step) => step.id === id);
    if (index !== -1) this.steps.splice(index, 1);
    this.refresh();
  }

  private refresh(): void {
    const next = this.stateNow();
    const key = `${next.state}\n${next.detail ?? ""}`;
    if (key === this.state) return;
    this.state = key;
    this.emit({ type: "state", state: next.state, detail: next.detail });
  }

  private stateNow(): State {
    const live = this.running();
    if (live.length > this.waits.length) return { state: "running", detail: live.at(-1)?.label };
    const reader = this.readers[0];
    if (reader !== undefined) return { state: "blocked", detail: reader.question };
    const want = this.wants[0];
    if (want !== undefined) return { state: "blocked", detail: want.label };
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
      emit: (event: ViewEvent) => this.emit(event),
      gate: ((question: string, shape?: z.ZodType) =>
        this.paused(() => this.gate(question, shape))) as Host["gate"],
      credential: (request: CredentialRequest) => this.credential(request),
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
    const id = `w${this.waitCounter++}`;
    const entry: Wait = { label };
    this.waits.push(entry);
    this.emit({ type: "wait", phase: "start", id, label });
    this.refresh();
    try {
      return await body();
    } finally {
      const index = this.waits.indexOf(entry);
      if (index !== -1) this.waits.splice(index, 1);
      this.emit({ type: "wait", phase: "end", id });
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

  private nextGateId(): string {
    return `g${this.gateCounter++}`;
  }
}

/** What tells ten parallel calls of one workflow apart in a tree. */
function summary(params: unknown): string | undefined {
  if (params === null || typeof params !== "object") return undefined;
  const parts = Object.entries(params as Record<string, unknown>).map(
    ([name, value]) => `${name}: ${short(value)}`,
  );
  return parts.length === 0 ? undefined : parts.join(", ");
}

function short(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  return text.length > 40 ? `${text.slice(0, 40)}...` : text;
}

function shownField(field: CredentialField): {
  name: string;
  label: string;
  secret: boolean;
  env?: string;
} {
  return { name: field.name, label: field.label, secret: field.secret === true, env: field.env };
}

function composePrompt(skillText: string, input: string | undefined, failure: string | undefined): string {
  const parts = [skillText.trim()];
  if (input !== undefined && input !== "") parts.push(`# Input\n\n${input}`);
  if (failure !== undefined) {
    parts.push(`# Correction\n\nThe last attempt failed: ${failure}\nDo the step again and fix that.`);
  }
  return `${parts.join("\n\n")}\n`;
}

function envelopeOf(call: TurnCall): z.ZodType | undefined {
  if (call.result === undefined) return undefined;
  if (call.blocked === undefined) return call.result;
  return z.union([
    z.strictObject({ result: call.result }),
    z.strictObject({ blocked: call.blocked }),
  ]);
}

function jsonSchema(shape: z.ZodType): Record<string, unknown> {
  const schema = z.toJSONSchema(shape) as Record<string, unknown>;
  delete schema["$schema"];
  return schema;
}

/** An agent CLI turns the schema into a tool schema, and a tool schema takes no union at its top level. */
function turnSchema(call: TurnCall): Record<string, unknown> | undefined {
  if (call.result === undefined) return undefined;
  if (call.blocked === undefined) return jsonSchema(call.result);
  return jsonSchema(
    z.object({
      result: call.result.optional().describe("fill this or blocked, and never both"),
      blocked: call.blocked.optional().describe("fill this or result, and never both"),
    }),
  );
}

function coerce(shape: z.ZodType, text: string): { value: unknown } | { problem: string } {
  let problem = "";
  for (const candidate of candidates(text)) {
    const checked = shape.safeParse(candidate);
    if (checked.success) return { value: checked.data };
    if (problem === "") problem = issues(checked.error);
  }
  return { problem };
}

function candidates(text: string): unknown[] {
  const trimmed = text.trim();
  const list: unknown[] = [trimmed, text];
  const asNumber = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(asNumber)) list.push(asNumber);
  const lowered = trimmed.toLowerCase();
  if (["yes", "y", "true"].includes(lowered)) list.push(true);
  if (["no", "n", "false"].includes(lowered)) list.push(false);
  if (text.includes(",")) list.push(trimmed.split(",").map((part) => part.trim()));
  list.push([trimmed]);
  const json = asJson(text);
  if (json !== undefined) list.push(json);
  return list;
}

function asJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.join(".");
      return at === "" ? issue.message : `${at}: ${issue.message}`;
    })
    .join("; ");
}
