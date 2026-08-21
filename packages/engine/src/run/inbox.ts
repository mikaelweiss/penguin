import type { Message } from "../core/message.ts";
import type { ViewEvent } from "../core/message.ts";
import { inboxPath } from "../paths.ts";
import { Tail } from "./follow.ts";
import { type AnySchema, jsonSchema, parseAnswer } from "./schema.ts";

type LiveRun = {
  emit(event: ViewEvent): void;
  refresh(): void;
  paused<T>(body: () => Promise<T>): Promise<T>;
};

type Reader = {
  question: string | undefined;
  gate: string | undefined;
  resolve(message: Message): void;
};

export class Inbox {
  private run: LiveRun;
  private tail: Tail | undefined;
  private gateCounter = 0;
  private readers: Reader[] = [];
  private queued: Message[] = [];

  constructor(run: LiveRun) {
    this.run = run;
  }

  open(dir: string): void {
    this.tail = new Tail(inboxPath(dir), (line) => this.ingest(line));
    this.tail.follow();
  }

  close(): void {
    this.tail?.stop();
    this.tail = undefined;
  }

  /** First waiting reader, if any. */
  blocked(): { detail: string | undefined } | undefined {
    const reader = this.readers[0];
    if (reader !== undefined) return { detail: reader.question };
    return undefined;
  }

  async gate(question: string, shape?: AnySchema): Promise<unknown> {
    const id = this.nextGateId();
    const schema = shape === undefined ? undefined : jsonSchema(shape);
    for (;;) {
      this.run.emit({ type: "gate", phase: "asked", id, question, schema });
      const { message } = this.read(question, id);
      const answer = await message;
      if (shape === undefined) return this.answered(id, question, answer);
      const taken = parseAnswer(shape, answer.text);
      if ("value" in taken) {
        this.answered(id, question, answer);
        return taken.value;
      }
      this.run.emit({
        type: "event",
        level: "warn",
        message: `the answer "${answer.text}" does not fit: ${taken.problem}`,
      });
    }
  }

  async gateUntil(question: string, halted: Promise<void>): Promise<string | undefined> {
    const id = this.nextGateId();
    this.run.emit({ type: "gate", phase: "asked", id, question });
    const reader = this.read(question, id);
    const message = await Promise.race([reader.message, halted.then(() => undefined)]);
    if (message === undefined) {
      reader.cancel();
      return undefined;
    }
    return this.answered(id, question, message);
  }

  read(question?: string, gate?: string): { message: Promise<Message>; cancel(): void } {
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
    this.run.refresh();
    return {
      message,
      cancel: () => {
        const index = this.readers.indexOf(reader);
        if (index === -1) return;
        this.readers.splice(index, 1);
        this.run.refresh();
      },
    };
  }

  private ingest(line: string): void {
    type Line = { text?: unknown; session?: unknown; gate?: unknown };
    let parsed: Line;
    try {
      parsed = JSON.parse(line) as Line;
    } catch {
      return;
    }
    if (typeof parsed.text !== "string") return;
    const message: Message = {
      text: parsed.text,
      session: typeof parsed.session === "string" ? parsed.session : undefined,
    };
    this.run.emit({ type: "message", text: message.text, session: message.session });
    const gate = typeof parsed.gate === "string" ? parsed.gate : undefined;
    const reader = this.pick(gate);
    if (reader === undefined) this.queued.push(message);
    else reader.resolve(message);
    this.run.refresh();
  }

  /**
   * The reader a message goes to: the one holding the gate it addresses, else the
   * earliest waiting reader. A gate no reader holds takes the unaddressed path.
   */
  private pick(gate: string | undefined): Reader | undefined {
    const addressed = gate === undefined ? -1 : this.readers.findIndex((one) => one.gate === gate);
    return this.readers.splice(addressed === -1 ? 0 : addressed, 1)[0];
  }

  private answered(id: string, question: string, message: Message): string {
    this.run.emit({ type: "gate", phase: "answered", id, question, answer: message.text });
    return message.text;
  }

  private nextGateId(): string {
    return `g${this.gateCounter++}`;
  }
}
