import type { z } from "zod";

export const COMPOSE: unique symbol = Symbol.for("penguin.compose");

export type Message = {
  text: string;
  session?: string;
  /** Which gate the message answers. Routing only: a delivered message never carries it. */
  gate?: string;
};

export type Messages = {
  next(): Promise<Message>;
};

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
