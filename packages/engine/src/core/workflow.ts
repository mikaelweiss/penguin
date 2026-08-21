import type { z } from "zod";
import { PenguinError } from "./errors.ts";
import type { Message } from "./message.ts";

export type Messages = {
  next(): Promise<Message>;
};

export type View = {
  activity<T>(label: string, body: () => Promise<T>): Promise<T>;
  fact(values: Record<string, string | number | boolean>): void;
  event(entry: { level?: "info" | "warn" | "error"; message: string; data?: unknown }): void;
  artifact(entry: { title: string; path?: string; url?: string }): void;
};

export type Turn<R> = Promise<R | undefined> & { stop(): Promise<void> };

export interface AgentSession {
  run<R extends z.ZodObject, B extends z.ZodObject>(
    prompt: string,
    options: { result: R; blocked: B },
  ): Turn<{ result: z.infer<R>; blocked?: never } | { blocked: z.infer<B>; result?: never }>;
  run<R extends z.ZodObject>(prompt: string, options: { result: R }): Turn<z.infer<R>>;
  run(prompt: string): Turn<null>;
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
  /** Blocks the run on a question only a person can answer. */
  gate(question: string): Promise<string>;
  gate<Shape extends z.ZodType>(question: string, shape: Shape): Promise<z.infer<Shape>>;
  messages: Messages;
  view: View;
  agent: AgentFactory;
  /** Runs another workflow inside this one, params validated, shown as one activity. */
  run<Schema extends z.ZodObject, R>(
    child: Workflow<Schema, R>,
    params: z.input<Schema>,
  ): Promise<R>;
} & Adapters;

export type Workflow<Schema extends z.ZodObject = z.ZodObject, R = unknown> = {
  description: string;
  params: Schema;
  run(ctx: Ctx<z.infer<Schema>>): Promise<R>;
};

export function workflow<Schema extends z.ZodObject, R>(
  definition: Workflow<Schema, R>,
): Workflow<Schema, R> {
  if (typeof definition.description !== "string" || definition.description.trim() === "") {
    throw new PenguinError("a workflow needs a description");
  }
  return definition;
}
