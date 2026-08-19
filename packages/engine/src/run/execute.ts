import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { type AgentOptions, type Ctx, type View, type Workflow, COMPOSE } from "../author/ctx.ts";
import type { CredentialRequest, Host } from "../author/host.ts";
import * as adapters from "../catalog/adapters.ts";
import { load } from "../catalog/loader.ts";
import { messageOf, PenguinError } from "../errors.ts";
import { runDir, stateRoot } from "../paths.ts";
import type { ViewEvent } from "../protocol/events.ts";
import { acquire } from "../protocol/lock.ts";
import { type RunRecord, readRun } from "../protocol/record.ts";
import { Bus } from "./bus.ts";
import { Inbox } from "./inbox.ts";
import { type AnySchema, schemaIssues } from "./schema.ts";
import { killActive, runArgv, runCommand } from "./spawn.ts";
import { Turns } from "./turns.ts";

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

type Step = { id: string; label: string; paused: boolean };

type Wait = { label: string };

type State = { state: "running" | "blocked" | "idle"; detail: string | undefined };

/** The event types that carry a position in the activity tree. */
const placed = new Set(["session", "agent", "gate", "step", "event", "wait"]);

class Execution {
  private dir: string;
  private record: RunRecord;
  private found: adapters.AdapterFound[];
  private bus: Bus;
  private als = new AsyncLocalStorage<ActivityStore>();
  private built = new Map<string, unknown>();
  private counter = 0;
  private activityCounter = 0;
  private waitCounter = 0;
  private steps: Step[] = [];
  private waits: Wait[] = [];
  private inbox: Inbox;
  private turns: Turns;
  private state = "";

  constructor(dir: string, record: RunRecord, found: adapters.AdapterFound[], bus: Bus) {
    this.dir = dir;
    this.record = record;
    this.found = found;
    this.bus = bus;
    this.inbox = new Inbox({
      emit: (event) => this.emit(event),
      refresh: () => this.refresh(),
      paused: (body) => this.paused(body),
    });
    this.turns = new Turns({
      dir,
      record,
      found,
      emit: (event) => this.emit(event),
      activityId: () => this.als.getStore()?.id,
      begin: (id, label) => this.begin(id, label),
      end: (id) => this.end(id),
      nextId: () => this.nextId(),
      paused: (body) => this.paused(body),
      gateUntil: (question, halted) => this.inbox.gateUntil(question, halted),
      resolveCwd: (relative) => this.resolveCwd(relative),
      build: (entry, host) => this.build(entry, host),
      host: () => this.host(),
    });
  }

  open(): void {
    this.inbox.open(this.dir);
  }

  close(): void {
    this.inbox.close();
    killActive();
  }

  ctx<Params>(params: Params): Ctx<Params> {
    const roles = new Set(
      this.found.map((entry) => entry.role).filter((role) => role !== "agent"),
    );
    const base: Record<string, unknown> = {
      params,
      gate: (question: string, shape?: AnySchema) => this.inbox.gate(question, shape),
      messages: { next: () => this.inbox.read().message },
      view: this.view(),
      agent: (options?: AgentOptions) => this.turns.session(options ?? {}),
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
          `nothing provides ctx.${prop}. Installed adapter roles: ${[...roles, "agent"].sort().join(", ")}. Adapters are files in ${adapters.searchedAdapters(this.record.cwd).join(" and ")}.`,
        );
      },
    });
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

  private async compose(definition: Workflow, args: unknown): Promise<unknown> {
    const checked = definition.params.safeParse(args);
    if (!checked.success) {
      throw new PenguinError(
        `invalid params for the workflow "${definition.description}": ${schemaIssues(checked.error)}`,
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

  private build(entry: adapters.AdapterFound, host: Host): unknown {
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
    const blocked = this.inbox.blocked();
    if (blocked !== undefined) return { state: "blocked", detail: blocked.detail };
    const wait = this.waits[0];
    if (wait !== undefined) return { state: "idle", detail: wait.label };
    return { state: "running", detail: undefined };
  }

  private host(): Host {
    return {
      cwd: this.record.cwd,
      state: stateRoot(),
      shell: (cmd, options) =>
        runCommand(cmd, this.resolveCwd(options?.cwd), { stdin: options?.stdin }),
      exec: (argv, options) => runArgv(argv, this.resolveCwd(options?.cwd), options),
      wait: <T>(label: string, body: () => Promise<T>): Promise<T> => this.wait(label, body),
      emit: (event: ViewEvent) => this.emit(event),
      gate: ((question: string, shape?: AnySchema) =>
        this.paused(() => this.inbox.gate(question, shape))) as Host["gate"],
      credential: (request: CredentialRequest) => this.inbox.credential(request),
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

  private resolveCwd(relative: string | undefined): string {
    return path.resolve(this.record.cwd, relative ?? ".");
  }

  private nextId(): string {
    const id = String(this.counter);
    this.counter += 1;
    return id;
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
