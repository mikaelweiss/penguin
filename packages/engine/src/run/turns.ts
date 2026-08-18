import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentOptions, AgentRunOptions, AgentSession } from "../author/ctx.ts";
import type { AgentAdapter, AgentTurnResult, Host } from "../author/host.ts";
import * as adapters from "../catalog/adapters.ts";
import { resolve as resolveSkill } from "../catalog/skills.ts";
import { PenguinError } from "../errors.ts";
import { transcriptsDir } from "../paths.ts";
import type { ViewEvent } from "../protocol/events.ts";
import type { RunRecord } from "../protocol/record.ts";
import {
    type AnySchema,
    type ObjectSchema,
    envelopeOf,
    schemaIssues,
    turnSchema,
} from "./schema.ts";
import { type Children, children, inScope, kill } from "./spawn.ts";

type LiveRun = {
  dir: string;
  record: RunRecord;
  found: adapters.AdapterFound[];
  emit(event: ViewEvent): void;
  activityId(): string | undefined;
  begin(id: string, label: string): void;
  end(id: string): void;
  nextId(): string;
  paused<T>(body: () => Promise<T>): Promise<T>;
  gateUntil(question: string, halted: Promise<void>): Promise<string | undefined>;
  resolveCwd(relative: string | undefined): string;
  build(entry: adapters.AdapterFound, host: Host): unknown;
  host(): Host;
};

type TurnCall = {
  session: string;
  api: AgentAdapter;
  cwd: string;
  options: Record<string, unknown>;
  skill: string;
  input: string | undefined;
  result: ObjectSchema | undefined;
  blocked: ObjectSchema | undefined;
  first: () => boolean;
  bump: () => void;
};

type Attempt =
  | { kind: "done"; value: unknown }
  | { kind: "stopped" }
  | { kind: "failed"; failure: string };

/** Agent sessions and the turn loop: skill, prompt, retry once, then gate. */
export class Turns {
  private named = new Map<string, number>();

  constructor(private readonly run: LiveRun) {}

  session(options: AgentOptions): AgentSession {
    const { use, cwd, name, ...rest } = options;
    const picked = adapters.pick(this.run.found, "agent", use);
    if ("missing" in picked) throw new PenguinError(picked.missing);
    if ("conflict" in picked) throw new PenguinError(picked.conflict);

    const id = crypto.randomUUID();
    const label = name === undefined || name === "" ? this.sessionName(picked.found.name) : name;
    const dir = this.run.resolveCwd(cwd);
    this.run.emit({ type: "session", id, name: label, use: picked.found.name, dir });
    const api = this.run.build(picked.found, this.agentHost()) as AgentAdapter;

    let attempts = 0;
    const runTurn = (
      skill: string,
      runOptions?: AgentRunOptions & { result?: ObjectSchema; blocked?: ObjectSchema },
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
    return { run: runTurn } as AgentSession;
  }

  private sessionName(use: string): string {
    const n = (this.named.get(use) ?? 0) + 1;
    this.named.set(use, n);
    return `${use}-${n}`;
  }

  private turn(call: TurnCall) {
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
    const id = this.run.nextId();
    const skillText = readSkill(call.skill, this.run.record.workflow, this.run.record.cwd);
    const envelope = envelopeOf(call);
    const schema = turnSchema(call);
    const label = `agent ${call.skill}`;
    const activity = this.run.activityId();
    this.run.emit({ type: "step", phase: "start", id, label, activity });
    this.run.begin(id, label);
    try {
      for (;;) {
        const attempt = await this.tryTurn(call, skillText, envelope, schema, set, stopped, id, activity);
        if (attempt.kind === "stopped") return this.endStep(id, label, activity, false, undefined);
        if (attempt.kind === "done") return this.endStep(id, label, activity, true, attempt.value);
        const answer = await this.run.paused(() =>
          this.run.gateUntil(
            `The agent step ${call.skill} failed twice: ${attempt.failure} Reply to run the step again.`,
            halted,
          ),
        );
        if (answer === undefined) return this.endStep(id, label, activity, false, undefined);
      }
    } finally {
      this.run.end(id);
    }
  }

  private async tryTurn(
    call: TurnCall,
    skillText: string,
    envelope: AnySchema | undefined,
    schema: Record<string, unknown> | undefined,
    set: Children,
    stopped: () => boolean,
    id: string,
    activity: string | undefined,
  ): Promise<Attempt> {
    let failure: string | undefined;
    for (let tries = 0; tries < 2; tries++) {
      const prompt = composePrompt(skillText, call.input, failure);
      transcribe(this.run.dir, call.session, `\n>>> ${call.skill}\n\n${prompt}\n`);
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
        return { kind: "stopped" };
      }
      if (stopped()) return { kind: "stopped" };
      if (outcome.ok) {
        if (envelope === undefined) return { kind: "done", value: null };
        const checked = envelope.safeParse(outcome.value);
        if (checked.success) return { kind: "done", value: checked.data };
        failure = schemaIssues(checked.error);
      } else {
        failure = outcome.error;
      }
      this.run.emit({
        type: "event",
        level: "warn",
        message: `step ${id} failed: ${failure}`,
        activity,
      });
    }
    return { kind: "failed", failure: failure ?? "" };
  }

  private endStep(
    id: string,
    label: string,
    activity: string | undefined,
    ok: boolean,
    value: unknown,
  ): unknown {
    this.run.emit({ type: "step", phase: "end", id, label, ok, activity });
    return value;
  }

  private agentHost(): Host {
    const base = this.run.host();
    return {
      ...base,
      emit: (event) => {
        if (event.type === "agent") {
          transcribe(
            this.run.dir,
            event.session,
            event.kind === "output" ? event.text : `${event.text}\n`,
          );
        }
        base.emit(event);
      },
    };
  }
}

function readSkill(skill: string, workflow: string, cwd: string): string {
  const found = resolveSkill(skill, workflow, cwd);
  if (found.file === undefined) {
    throw new PenguinError(`no skill ${skill}. Looked in ${found.searched.join(", ")}`);
  }
  return fs.readFileSync(found.file, "utf8");
}

function transcribe(dir: string, session: string, text: string): void {
  const folder = transcriptsDir(dir);
  fs.mkdirSync(folder, { recursive: true });
  fs.appendFileSync(path.join(folder, `${session}.txt`), text);
}

function composePrompt(skillText: string, input: string | undefined, failure: string | undefined): string {
  const parts = [skillText.trim()];
  if (input !== undefined && input !== "") parts.push(`# Input\n\n${input}`);
  if (failure !== undefined) {
    parts.push(`# Correction\n\nThe last attempt failed: ${failure}\nDo the step again and fix that.`);
  }
  return `${parts.join("\n\n")}\n`;
}
