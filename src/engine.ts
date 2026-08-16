import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { attempt } from "./agent.ts";
import { ask } from "./ask.ts";
import { messageOf, Parked, WaError } from "./errors.ts";
import * as journal from "./journal.ts";
import { acquire } from "./lock.ts";
import { load } from "./loader.ts";
import { agentFile, pinnedWorkflow, runDir, transcriptsDir } from "./paths.ts";
import { killActive, runCommand } from "./spawn.ts";
import type { AgentOptions, CommandOptions, CommandResult, Step } from "./types.ts";

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
  const execution = new Execution(dir, start, journal.answersOf(entries));
  try {
    await definition.run({
      params,
      step: execution.step,
      gate: (question: string) => execution.gate(question),
    });
  } catch (error) {
    if (error instanceof Parked) {
      execution.close();
      say(`parked: ${error.message}`);
      return error.fatal ? "failed" : "parked";
    }
    execution.close();
    const reason = messageOf(error);
    journal.append(dir, { type: "park", reason });
    say(`parked: ${reason}`);
    return "failed";
  }
  execution.close();
  journal.append(dir, { type: "done" });
  say("done");
  return "done";
}

class Execution {
  step: Step;

  private dir: string;
  private start: journal.StartEntry;
  private answers: Map<string, journal.CallEntry>;
  private counter = 0;
  private closed = false;

  constructor(dir: string, start: journal.StartEntry, answers: Map<string, journal.CallEntry>) {
    this.dir = dir;
    this.start = start;
    this.answers = answers;
    this.step = {
      agent: (skill: string, options?: AgentOptions & { result?: z.ZodObject }) =>
        this.agent(skill, options),
      command: (cmd: string, options?: CommandOptions) => this.command(cmd, options),
    } as Step;
  }

  async gate(question: string): Promise<string> {
    return this.gateAt(this.nextId(), question);
  }

  close(): void {
    this.closed = true;
    killActive();
  }

  private record(entry: journal.Entry): void {
    if (this.closed) return;
    journal.append(this.dir, entry);
  }

  private async command(cmd: string, options?: CommandOptions): Promise<CommandResult> {
    const id = this.nextId();
    const key = JSON.stringify({ cmd, cwd: options?.cwd ?? null });
    const recorded = this.lookup(id, "command", key);
    if (recorded !== undefined) return recorded.result as CommandResult;
    say(`step ${id} command ${cmd}`);
    const result = await runCommand(cmd, this.resolveCwd(options?.cwd));
    this.record({ type: "call", id, kind: "command", key, result });
    return result;
  }

  private async agent(
    skill: string,
    options?: AgentOptions & { result?: z.ZodObject },
  ): Promise<unknown> {
    const id = this.nextId();
    const key = JSON.stringify({
      skill,
      input: options?.input ?? null,
      agent: options?.agent ?? null,
      cwd: options?.cwd ?? null,
    });
    const recorded = this.lookup(id, "agent", key);
    if (recorded !== undefined) return recorded.result;

    const command = options?.agent ?? defaultAgent();
    if (command === undefined) {
      throw this.parkError(`no agent is configured. Write this line to ${agentFile()}: claude -p`, true);
    }
    const skillPath = path.resolve(path.dirname(this.start.workflow), skill);
    if (!fs.existsSync(skillPath)) throw this.parkError(`no skill file at ${skillPath}`, true);
    const skillText = fs.readFileSync(skillPath, "utf8");
    const cwd = this.resolveCwd(options?.cwd);
    fs.mkdirSync(transcriptsDir(this.dir), { recursive: true });

    for (let round = 0; ; round++) {
      let failure: string | undefined;
      for (let tries = 0; tries < 2; tries++) {
        say(`step ${id} agent ${skill}`);
        const outcome = await attempt({
          command,
          skill,
          skillText,
          input: options?.input,
          result: options?.result,
          cwd,
          transcript: this.transcript(id, round, tries),
          failure,
        });
        if (outcome.ok) {
          this.record({ type: "call", id, kind: "agent", key, result: outcome.value });
          return outcome.value;
        }
        failure = outcome.error;
        say(`step ${id} failed: ${failure}`);
      }
      await this.gateAt(
        `${id}/gate/${round}`,
        `The agent step ${skill} failed twice: ${failure} Reply to run the step again.`,
      );
    }
  }

  private async gateAt(id: string, question: string): Promise<string> {
    const key = JSON.stringify({ question });
    const recorded = this.lookup(id, "gate", key);
    if (recorded !== undefined) return String(recorded.result);
    const answer = await ask(question);
    if (answer === undefined) {
      this.record({ type: "gate", id, key, question });
      throw new Parked(`gate: ${question}`, false);
    }
    this.record({ type: "call", id, kind: "gate", key, result: answer });
    return answer;
  }

  private lookup(id: string, kind: journal.Kind, key: string): journal.CallEntry | undefined {
    const entry = this.answers.get(id);
    if (entry === undefined) return undefined;
    if (entry.kind !== kind || entry.key !== key) {
      throw this.parkError(
        `divergence at step ${id}: the journal holds ${entry.kind} ${entry.key}, the run asked for ${kind} ${key}`,
        true,
      );
    }
    return entry;
  }

  private parkError(reason: string, fatal: boolean): Parked {
    this.record({ type: "park", reason });
    return new Parked(reason, fatal);
  }

  private transcript(id: string, round: number, tries: number): string {
    const stem = id.replaceAll("/", "-");
    return path.join(transcriptsDir(this.dir), `${stem}.${round}.${tries}.txt`);
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

export function defaultAgent(): string | undefined {
  const file = agentFile();
  if (!fs.existsSync(file)) return undefined;
  const line = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((text) => text.trim())
    .find((text) => text !== "" && !text.startsWith("#"));
  return line;
}

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}
