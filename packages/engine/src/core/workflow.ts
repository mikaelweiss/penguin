import type { z } from "zod";
import { PenguinError } from "./errors.ts";

/** The roles the installed adapters put on ctx. penguin-env.d.ts merges them in. */
export interface Adapters {}

export type Ctx<Params> = { params: Params } & Adapters;

/** The engine's hook on ctx that spawns a child workflow as its own run. */
export const RUN: unique symbol = Symbol.for("penguin.run");

export type RunHooks = {
  spawn(file: string, params: unknown): Promise<unknown>;
};

export type Workflow<Schema extends z.ZodObject = z.ZodObject, R = unknown> = {
  description: string;
  params: Schema;
  run(ctx: Ctx<z.infer<Schema>>): Promise<R>;
  /** The definition's own file, so call can spawn it. workflow() fills it in. */
  file?: string;
};

export function workflow<Schema extends z.ZodObject, R>(
  definition: Workflow<Schema, R>,
): Workflow<Schema, R> {
  if (typeof definition.description !== "string" || definition.description.trim() === "") {
    throw new PenguinError("a workflow needs a description");
  }
  if (definition.file === undefined) definition.file = definitionSite();
  return definition;
}

/** The file that called workflow(), read off the stack. */
function definitionSite(): string | undefined {
  const stack = new Error().stack ?? "";
  for (const line of stack.split("\n").slice(1)) {
    const match = /(?:file:\/\/)?(\/[^)\s]+?\.(?:ts|tsx|js|jsx|mjs|cjs)):\d+:\d+\)?\s*$/.exec(line);
    const file = match?.[1];
    if (file === undefined || file.includes("/core/workflow.ts")) continue;
    return decodeURIComponent(file);
  }
  return undefined;
}

/**
 * Runs a child workflow as its own run: a new process, a new run folder, the
 * child's params validated. Stopping the child rejects with RunStopped, a
 * process death without an outcome with RunCrashed, and a child that threw
 * rejects with its message. Outside an engine run it falls back to running the
 * child in place.
 */
export function call<Schema extends z.ZodObject, R>(
  ctx: Ctx<unknown>,
  child: Workflow<Schema, R>,
  params: z.input<Schema>,
): Promise<R> {
  const parsed = child.params.parse(params);
  const hooks = (ctx as unknown as Record<PropertyKey, unknown>)[RUN] as RunHooks | undefined;
  if (hooks === undefined || child.file === undefined) {
    return child.run({ ...ctx, params: parsed });
  }
  return hooks.spawn(child.file, parsed) as Promise<R>;
}
