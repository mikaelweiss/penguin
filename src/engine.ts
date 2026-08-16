import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import * as adapters from "./adapters.ts";
import { ask } from "./ask.ts";
import { messageOf, Parked, WaError } from "./errors.ts";
import * as journal from "./journal.ts";
import { acquire } from "./lock.ts";
import { load } from "./loader.ts";
import { pinnedWorkflow, runDir, transcriptsDir } from "./paths.ts";
import { resolve as resolveSkill } from "./skills.ts";
import { killActive, runArgv, runCommand } from "./spawn.ts";
import type {
  AgentAdapter,
  AgentOptions,
  AgentRunOptions,
  AgentSession,
  Ctx,
  Host,
  View,
  ViewAdapter,
  ViewEvent,
} from "./types.ts";
import { Bus, plainRenderer } from "./view.ts";

export type Outcome = "done" | "parked" | "failed";

export async function execute(name: string, reply?: string): Promise<Outcome> {
  const dir = runDir(name);
  if (!fs.existsSync(journal.journalPath(dir))) throw new WaError(`no run named ${name}`);
  const release = acquire(dir);
  const onSignal = (signal: NodeJS.Signals): void => {
    killActive();
    journal.append(dir, { type: "park", reason: `interrupted by ${signal}` });
    release();
    process.stdout.write(`\nparked: interrupted by ${signal}\n`);
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    if (reply !== undefined) answerPendingGate(dir, reply);
    return await drive(dir);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    release();
  }
}

function answerPendingGate(dir: string, reply: string): void {
  const entries = journal.read(dir);
  if (journal.isDone(entries)) throw new WaError("the run is done");
  const pending = journal.pendingGate(entries);
  if (pending === undefined) throw new WaError("the run has no pending gate to answer");
  journal.append(dir, {
    type: "call",
    id: pending.id,
    kind: "gate",
    key: pending.key,
    result: reply,
  });
}

async function drive(dir: string): Promise<Outcome> {
  const entries = journal.read(dir);
  if (journal.isDone(entries)) throw new WaError("the run is done");
  const start = journal.startOf(entries);
  const definition = await load(pinnedWorkflow(dir));
  const params = definition.params.parse(start.params);
  const found = await adapters.installed(start.cwd);
  const answers = journal.answersOf(entries);
  const fresh = answers.size === 0;
  const execution = new Execution(dir, start, answers, found, fresh);
  execution.emitAlways({ type: "run", phase: fresh ? "started" : "resumed", run: path.basename(dir) });
  try {
    await definition.run(execution.ctx(params));
  } catch (error) {
    if (error instanceof Parked) {
      execution.close();
      execution.emitAlways({
        type: "run",
        phase: "parked",
        run: path.basename(dir),
        reason: error.message,
      });
      say(`parked: ${error.message}`);
      return error.fatal ? "failed" : "parked";
    }
    execution.close();
    const reason = messageOf(error);
    journal.append(dir, { type: "park", reason });
    execution.emitAlways({ type: "run", phase: "parked", run: path.basename(dir), reason });
    say(`parked: ${reason}`);
    return "failed";
  }
  execution.close();
  journal.append(dir, { type: "done" });
  execution.emitAlways({ type: "run", phase: "done", run: path.basename(dir) });
  say("done");
  return "done";
}

type ActivityStore = { id: string };

class Execution {
  private dir: string;
  private start: journal.StartEntry;
  private answers: Map<string, journal.CallEntry>;
  private found: adapters.Found[];
  private bus: Bus;
  private als = new AsyncLocalStorage<ActivityStore>();
  private built = new Map<string, unknown>();
  private counter = 0;
  private activityCounter = 0;
  private replayed = 0;
  private closed = false;

  constructor(
    dir: string,
    start: journal.StartEntry,
    answers: Map<string, journal.CallEntry>,
    found: adapters.Found[],
    live: boolean,
  ) {
    this.dir = dir;
    this.start = start;
    this.answers = answers;
    this.found = found;
    this.bus = new Bus(dir, this.renderer(), live);
  }

  ctx<Params>(params: Params): Ctx<Params> {
    const roles = new Set(
      this.found.map((entry) => entry.role).filter((role) => role !== "agent" && role !== "view"),
    );
    const base: Record<string, unknown> = {
      params,
      gate: (question: string) => this.gate(question),
      view: this.view(),
      agent: (options?: AgentOptions) => this.session(options ?? {}),
    };
    const cached = new Map<string, unknown>();
    const target = base as unknown as Ctx<Params>;
    return new Proxy(target, {
      get: (_, prop) => {
        if (typeof prop !== "string") return undefined;
        if (prop in base) return base[prop];
        if (roles.has(prop)) {
          const ready = cached.get(prop);
          if (ready !== undefined) return ready;
          const built = this.role(prop);
          cached.set(prop, built);
          return built;
        }
        throw this.parkError(
          `nothing provides ctx.${prop}. Installed adapter roles: ${[...roles, "agent", "view"].sort().join(", ")}. Adapters are files in ${adapters.searched(this.start.cwd).join(" and ")}.`,
          true,
        );
      },
    });
  }

  async gate(question: string): Promise<string> {
    return this.gateAt(this.nextId(), question);
  }

  emitAlways(event: ViewEvent): void {
    this.bus.emit(event, true);
  }

  close(): void {
    this.closed = true;
    killActive();
  }

  private renderer(): ViewAdapter {
    const picked = adapters.pick(this.found, "view");
    if (!("found" in picked)) return plainRenderer();
    try {
      const host = this.host();
      return picked.found.definition.build({ ...host, emit: () => {} }) as ViewAdapter;
    } catch (error) {
      process.stderr.write(`wa: the view adapter failed to build: ${messageOf(error)}\n`);
      return plainRenderer();
    }
  }

  private view(): View {
    return {
      activity: async <T>(label: string, body: () => Promise<T>): Promise<T> => {
        const id = `a${this.activityCounter++}`;
        const parent = this.als.getStore()?.id;
        this.bus.openActivity(id, parent, label);
        try {
          const value = await this.als.run({ id }, body);
          this.bus.closeActivity(id, "ok");
          return value;
        } catch (error) {
          this.bus.closeActivity(id, error instanceof Parked ? "parked" : "failed");
          throw error;
        }
      },
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

  private role(role: string): unknown {
    const picked = adapters.pick(this.found, role);
    if ("missing" in picked) throw this.parkError(picked.missing, true);
    if ("conflict" in picked) throw this.parkError(picked.conflict, true);
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
    const key = JSON.stringify({ role, method, args });
    const recorded = this.lookup(id, "adapter", key);
    if (recorded !== undefined) return recorded.result;
    const label = `${role}.${method}`;
    const activity = this.als.getStore()?.id;
    this.bus.emit({ type: "step", phase: "start", id, label, activity });
    let value: unknown;
    try {
      value = (await fn(...args)) ?? null;
    } catch (error) {
      this.bus.emit({ type: "step", phase: "end", id, label, ok: false, activity });
      throw error;
    }
    this.record({ type: "call", id, kind: "adapter", key, result: value });
    this.bus.emit({ type: "step", phase: "end", id, label, ok: true, activity });
    return value;
  }

  private session(options: AgentOptions): AgentSession {
    const { use, cwd, ...rest } = options;
    const picked = adapters.pick(this.found, "agent", use);
    if ("missing" in picked) throw this.parkError(picked.missing, true);
    if ("conflict" in picked) throw this.parkError(picked.conflict, true);
    const id = this.nextId();
    const key = JSON.stringify({
      use: picked.found.name,
      cwd: cwd ?? null,
      options: rest,
    });
    const recorded = this.lookup(id, "session", key);
    let session: string;
    if (recorded !== undefined) {
      session = String(recorded.result);
    } else {
      session = crypto.randomUUID();
      this.record({ type: "call", id, kind: "session", key, result: session });
    }
    const api = this.build(picked.found, this.agentHost()) as AgentAdapter;
    let attempts = 0;
    const turn = (skill: string, runOptions?: AgentRunOptions & { result?: z.ZodObject }) =>
      this.agentTurn({
        session,
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
    return { run: turn } as AgentSession;
  }

  private async agentTurn(call: {
    session: string;
    api: AgentAdapter;
    cwd: string;
    options: Record<string, unknown>;
    skill: string;
    input: string | undefined;
    result: z.ZodObject | undefined;
    first: () => boolean;
    bump: () => void;
  }): Promise<unknown> {
    const id = this.nextId();
    const key = JSON.stringify({
      session: call.session,
      skill: call.skill,
      input: call.input ?? null,
    });
    const recorded = this.lookup(id, "agent", key);
    if (recorded !== undefined) {
      call.bump();
      return recorded.result;
    }

    const found = resolveSkill(call.skill, this.start.workflow, this.start.cwd);
    if (found.file === undefined) {
      throw this.parkError(`no skill ${call.skill}. Looked in ${found.searched.join(", ")}`, true);
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

    for (let round = 0; ; round++) {
      let failure: string | undefined;
      for (let tries = 0; tries < 2; tries++) {
        const prompt = composePrompt(skillText, call.input, failure);
        this.transcribe(call.session, `\n>>> ${call.skill}\n\n${prompt}\n`);
        const first = call.first();
        call.bump();
        const outcome = await call.api.turn({
          session: call.session,
          first,
          cwd: call.cwd,
          prompt,
          schema,
          options: call.options,
        });
        if (outcome.ok) {
          if (call.result === undefined) {
            this.record({ type: "call", id, kind: "agent", key, result: null });
            this.bus.emit({ type: "step", phase: "end", id, label, ok: true, activity });
            return null;
          }
          const checked = call.result.safeParse(outcome.value);
          if (checked.success) {
            this.record({ type: "call", id, kind: "agent", key, result: checked.data });
            this.bus.emit({ type: "step", phase: "end", id, label, ok: true, activity });
            return checked.data;
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
      await this.gateAt(
        `${id}/gate/${round}`,
        `The agent step ${call.skill} failed twice: ${failure} Reply to run the step again.`,
      );
    }
  }

  private async gateAt(id: string, question: string): Promise<string> {
    const key = JSON.stringify({ question });
    const recorded = this.lookup(id, "gate", key);
    if (recorded !== undefined) return String(recorded.result);
    this.bus.emit({ type: "gate", phase: "asked", question });
    const answer = await ask(question);
    if (answer === undefined) {
      this.record({ type: "gate", id, key, question });
      throw new Parked(`gate: ${question}`, false);
    }
    this.record({ type: "call", id, kind: "gate", key, result: answer });
    this.bus.emit({ type: "gate", phase: "answered", question, answer });
    return answer;
  }

  private host(): Host {
    return {
      cwd: this.start.cwd,
      shell: (cmd, options) =>
        runCommand(cmd, this.resolveCwd(options?.cwd), { stdin: options?.stdin }),
      exec: (argv, options) => runArgv(argv, this.resolveCwd(options?.cwd), options),
      emit: (event) => this.bus.emit(event),
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

  private transcribe(session: string, text: string): void {
    const dir = transcriptsDir(this.dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${session}.txt`), text);
  }

  private lookup(id: string, kind: journal.Kind, key: string): journal.CallEntry | undefined {
    const entry = this.answers.get(id);
    if (entry === undefined) {
      this.bus.goLive();
      return undefined;
    }
    if (entry.kind !== kind || entry.key !== key) {
      throw this.parkError(
        `divergence at step ${id}: the journal holds ${entry.kind} ${entry.key}, the run asked for ${kind} ${key}`,
        true,
      );
    }
    this.replayed += 1;
    if (this.replayed >= this.answers.size) this.bus.goLive();
    return entry;
  }

  private record(entry: journal.Entry): void {
    if (this.closed) return;
    journal.append(this.dir, entry);
  }

  private parkError(reason: string, fatal: boolean): Parked {
    this.record({ type: "park", reason });
    return new Parked(reason, fatal);
  }

  private resolveCwd(relative: string | undefined): string {
    return path.resolve(this.start.cwd, relative ?? ".");
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

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}
