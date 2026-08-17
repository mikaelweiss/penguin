import type { z } from "zod";

export const COMPOSE: unique symbol = Symbol.for("wa.compose");

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type Message = { text: string; session?: string };

export type ViewEvent =
  | {
      type: "run";
      phase: "started" | "done" | "stopped" | "error";
      run: string;
      reason?: string;
      result?: unknown;
    }
  | { type: "state"; state: "running" | "blocked" | "idle"; detail?: string }
  | { type: "session"; id: string; name: string; use: string }
  | { type: "message"; text: string; session?: string }
  | { type: "activity"; phase: "start"; id: string; parent?: string; label: string }
  | { type: "activity"; phase: "end"; id: string; outcome: "ok" | "failed" }
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
  | { type: "agent"; session: string; kind: "text" | "tool" | "output"; text: string; activity?: string }
  | { type: "gate"; phase: "asked"; question: string; schema?: Record<string, unknown> }
  | { type: "gate"; phase: "answered"; question: string; answer: string };

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
  run<R extends z.ZodObject>(skill: string, options: AgentRunOptions & { result: R }): Turn<z.infer<R>>;
  run(skill: string, options?: AgentRunOptions): Turn<null>;
}

export type AgentOptions = {
  use?: string;
  cwd?: string;
  name?: string;
} & Record<string, unknown>;

export type AgentFactory = (options?: AgentOptions) => AgentSession;

/** The roles the installed adapters put on ctx. wa-env.d.ts merges them in. */
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

export type Host = {
  /** The run's invoking folder. Relative cwd options resolve against it. */
  cwd: string;
  shell(cmd: string, options?: ShellOptions): Promise<CommandResult>;
  exec(argv: string[], options?: ExecOptions): Promise<number>;
  wait<T>(label: string, body: () => Promise<T>): Promise<T>;
  emit(event: ViewEvent): void;
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
