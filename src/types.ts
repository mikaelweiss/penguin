import type { z } from "zod";

export const COMPOSE: unique symbol = Symbol.for("penguin.compose");

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type Message = {
  text: string;
  session?: string;
  /** Which gate the message answers. Routing only: a delivered message never carries it. */
  gate?: string;
};

export type ViewEvent =
  | {
      type: "run";
      phase: "started" | "done" | "stopped" | "error";
      run: string;
      reason?: string;
      result?: unknown;
    }
  | { type: "state"; state: "running" | "blocked" | "idle"; detail?: string }
  | { type: "session"; id: string; name: string; use: string; activity?: string }
  | { type: "message"; text: string; session?: string }
  | {
      type: "activity";
      phase: "start";
      id: string;
      parent?: string;
      label: string;
      /** What tells two calls of the same label apart: a compact summary of the params. */
      detail?: string;
    }
  | { type: "activity"; phase: "end"; id: string; outcome: "ok" | "failed" }
  | { type: "wait"; phase: "start"; id: string; label: string; activity?: string }
  | { type: "wait"; phase: "end"; id: string; activity?: string }
  | { type: "step"; phase: "start"; id: string; label: string; activity?: string }
  | { type: "step"; phase: "end"; id: string; label: string; ok: boolean; activity?: string }
  | { type: "fact"; values: Record<string, string | number | boolean> }
  | {
      type: "event";
      level: "info" | "warn" | "error";
      message: string;
      data?: unknown;
      activity?: string;
    }
  | { type: "artifact"; title: string; path?: string; url?: string }
  | { type: "watch"; elapsed?: boolean; diff?: string }
  | {
      type: "agent";
      session: string;
      kind: "text" | "thinking" | "tool" | "output";
      text: string;
      /** For a tool, what it acts on: the command, the file, the pattern. */
      detail?: string;
      activity?: string;
    }
  | {
      type: "gate";
      phase: "asked";
      id: string;
      question: string;
      schema?: Record<string, unknown>;
      activity?: string;
    }
  | { type: "gate"; phase: "answered"; id: string; question: string; answer: string; activity?: string }
  | {
      type: "credential";
      phase: "asked";
      name: string;
      label: string;
      url?: string;
      hint?: string;
      fields: { name: string; label: string; secret: boolean; env?: string }[];
    }
  | {
      type: "credential";
      phase: "rejected";
      name: string;
      label: string;
      reason: string;
      where: string;
      url?: string;
      hint?: string;
      fields: { name: string; label: string; secret: boolean; env?: string }[];
    }
  | { type: "credential"; phase: "ready"; name: string; where: string };

export type View = {
  activity<T>(label: string, body: () => Promise<T>): Promise<T>;
  fact(values: Record<string, string | number | boolean>): void;
  event(entry: { level?: "info" | "warn" | "error"; message: string; data?: unknown }): void;
  artifact(entry: { title: string; path?: string; url?: string }): void;
  watch(readouts: { elapsed?: boolean; diff?: string }): void;
};

export type Messages = {
  next(): Promise<Message>;
};

export type AgentRunOptions = {
  input?: string;
};

export type Turn<R> = Promise<R | undefined> & { stop(): Promise<void> };

export interface AgentSession {
  run<R extends z.ZodObject, B extends z.ZodObject>(
    skill: string,
    options: AgentRunOptions & { result: R; blocked: B },
  ): Turn<{ result: z.infer<R>; blocked?: never } | { blocked: z.infer<B>; result?: never }>;
  run<R extends z.ZodObject>(skill: string, options: AgentRunOptions & { result: R }): Turn<z.infer<R>>;
  run(skill: string, options?: AgentRunOptions): Turn<null>;
}

export type AgentOptions = {
  use?: string;
  cwd?: string;
  name?: string;
} & Record<string, unknown>;

export type AgentFactory = (options?: AgentOptions) => AgentSession;

/** The roles the installed adapters put on ctx. penguin-env.d.ts merges them in. */
export interface Adapters {}

export type Ctx<Params> = {
  params: Params;
  gate(question: string): Promise<string>;
  gate<Shape extends z.ZodType>(question: string, shape: Shape): Promise<z.infer<Shape>>;
  messages: Messages;
  view: View;
  agent: AgentFactory;
} & Adapters;

export type WorkflowDefinition<Schema extends z.ZodObject, R> = {
  description: string;
  params: Schema;
  run(ctx: Ctx<z.infer<Schema>>): Promise<R>;
};

export type Workflow<Schema extends z.ZodObject = z.ZodObject, R = unknown> = ((
  ctx: Ctx<unknown>,
  params: z.input<Schema>,
) => Promise<R>) &
  WorkflowDefinition<Schema, R>;

export type ShellOptions = {
  cwd?: string;
  stdin?: string;
};

export type ExecOptions = ShellOptions & {
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
};

export type CredentialField = {
  /** The key under which the value is stored, and the key on the returned object. */
  name: string;
  /** What to show the human who types the value. */
  label: string;
  /** An environment variable that supplies the value instead. */
  env?: string;
  /** A secret value: never shown, never logged. */
  secret?: boolean;
};

export type CredentialRequest = {
  /** The name of the stored record: lowercase letters, digits, and dashes. */
  name: string;
  /** What the credential is for, shown to the human. */
  label: string;
  /** Where the human makes the key. The viewer shows it as a link. */
  url?: string;
  /** One line of extra instruction. */
  hint?: string;
  fields: readonly CredentialField[];
  /**
   * Why the provider refused the values. penguin asks the user to try again, type them
   * again, edit the file, or stop the run, then returns whatever the store holds after.
   */
  rejected?: string;
};

export type Host = {
  /** The run's invoking folder. Relative cwd options resolve against it. */
  cwd: string;
  shell(cmd: string, options?: ShellOptions): Promise<CommandResult>;
  exec(argv: string[], options?: ExecOptions): Promise<number>;
  wait<T>(label: string, body: () => Promise<T>): Promise<T>;
  emit(event: ViewEvent): void;
  /**
   * The values the adapter needs from the user, one field per value. Environment
   * variables win, then the stored record. Anything still missing blocks the run
   * until a viewer takes it and writes it to the store.
   */
  credential<const R extends CredentialRequest>(
    request: R,
  ): Promise<Record<R["fields"][number]["name"], string>>;
};

export type AgentTurn = {
  session: string;
  first: boolean;
  cwd: string;
  prompt: string;
  schema?: Record<string, unknown>;
  options: Record<string, unknown>;
};

export type AgentTurnResult = { ok: true; value: unknown } | { ok: false; error: string };

export type AgentAdapter = {
  turn(turn: AgentTurn): Promise<AgentTurnResult>;
};

export type ViewAdapter = {
  render(event: ViewEvent): void;
};

export type Adapter<A = unknown> = {
  role: string;
  name: string;
  description: string;
  build(host: Host): A;
};
