import type { Message } from "../author/ctx.ts";
import type { CredentialField, CredentialRequest } from "../author/host.ts";
import { inboxPath } from "../paths.ts";
import * as credentials from "../protocol/credentials.ts";
import type { ViewEvent } from "../protocol/events.ts";
import { Tail } from "../protocol/follow.ts";
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

type Want = { name: string; label: string; resolve(): void };

export class Inbox {
  private run: LiveRun;
  private tail: Tail | undefined;
  private gateCounter = 0;
  private readers: Reader[] = [];
  private queued: Message[] = [];
  private wants: Want[] = [];

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

  /** First waiting reader or credential ask, if any. */
  blocked(): { detail: string | undefined } | undefined {
    const reader = this.readers[0];
    if (reader !== undefined) return { detail: reader.question };
    const want = this.wants[0];
    if (want !== undefined) return { detail: want.label };
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

  /**
   * The values an adapter needs from the user. A secret never travels as a message: a
   * viewer writes it to the credential store and says only that the store now holds it.
   */
  async credential(request: CredentialRequest): Promise<Record<string, string>> {
    const rejected = request.rejected;
    if (rejected !== undefined) await this.run.paused(() => this.refused(request, rejected));
    for (;;) {
      const taken = this.take(request);
      if (taken.missing.length === 0) {
        this.run.emit({ type: "credential", phase: "ready", name: request.name, where: taken.where });
        return taken.values;
      }
      await this.run.paused(() => this.ask(request, taken.missing));
    }
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
    this.run.emit({
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
    this.run.emit({
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
      this.run.refresh();
    });
  }

  private provided(name: string): void {
    const waiting = this.wants.filter((want) => want.name === name);
    this.wants = this.wants.filter((want) => want.name !== name);
    for (const want of waiting) want.resolve();
    this.run.refresh();
  }

  private nextGateId(): string {
    return `g${this.gateCounter++}`;
  }
}

function shownField(field: CredentialField): {
  name: string;
  label: string;
  secret: boolean;
  env?: string;
} {
  return { name: field.name, label: field.label, secret: field.secret === true, env: field.env };
}
