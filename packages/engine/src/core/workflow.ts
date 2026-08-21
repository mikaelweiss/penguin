import type { z } from "zod";
import { PenguinError } from "./errors.ts";

/** The roles the installed adapters put on ctx. penguin-env.d.ts merges them in. */
export interface Adapters {}

export type Ctx<Params> = { params: Params } & Adapters;

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

/** Runs a child workflow with the same adapters, its params validated. */
export function call<Schema extends z.ZodObject, R>(
  ctx: Ctx<unknown>,
  child: Workflow<Schema, R>,
  params: z.input<Schema>,
): Promise<R> {
  return child.run({ ...ctx, params: child.params.parse(params) });
}
