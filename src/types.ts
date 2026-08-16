import type { z } from "zod";

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type ViewEvent =
  | { type: "run"; phase: "started" | "resumed" | "done" | "parked"; run: string; reason?: string }
  | { type: "activity"; phase: "start"; id: string; parent?: string; label: string }
  | { type: "activity"; phase: "end"; id: string; outcome: "ok" | "failed" | "parked" }
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
  | { type: "gate"; phase: "asked"; question: string }
  | { type: "gate"; phase: "answered"; question: string; answer: string };

export type View = {
  activity<T>(label: string, body: () => Promise<T>): Promise<T>;
  fact(values: Record<string, string | number | boolean>): void;
  event(entry: { level?: "info" | "warn" | "error"; message: string; data?: unknown }): void;
  artifact(entry: { title: string; path?: string; url?: string }): void;
  watch(readouts: { elapsed?: boolean; diff?: string }): void;
};

export type AgentRunOptions = {
  input?: string;
};

export interface AgentSession {
  run<R extends z.ZodObject>(
    skill: string,
    options: AgentRunOptions & { result: R },
  ): Promise<z.infer<R>>;
  run(skill: string, options?: AgentRunOptions): Promise<void>;
}

export type AgentOptions = {
  use?: string;
  cwd?: string;
} & Record<string, unknown>;

export type AgentFactory = (options?: AgentOptions) => AgentSession;

/** The roles the installed adapters put on ctx. wa-env.d.ts merges them in. */
export interface Adapters {}

export type Ctx<Params> = {
  params: Params;
  gate(question: string): Promise<string>;
  view: View;
  agent: AgentFactory;
} & Adapters;

export type Workflow<Schema extends z.ZodObject = z.ZodObject> = {
  description: string;
  params: Schema;
  run(ctx: Ctx<z.infer<Schema>>): Promise<void>;
};

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
