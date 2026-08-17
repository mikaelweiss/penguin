import type { z } from "zod";
import { WaError } from "./errors.ts";
import { COMPOSE, type Ctx, type Workflow, type WorkflowDefinition } from "./types.ts";

type Composer = {
  [COMPOSE]?: (definition: unknown, params: unknown) => Promise<unknown>;
};

export function workflow<Schema extends z.ZodObject, R>(
  definition: WorkflowDefinition<Schema, R>,
): Workflow<Schema, R> {
  if (typeof definition.description !== "string" || definition.description.trim() === "") {
    throw new WaError("a workflow needs a description");
  }
  const call = (ctx: Ctx<unknown>, params: z.input<Schema>): Promise<R> => {
    const compose = (ctx as unknown as Composer)[COMPOSE];
    if (compose === undefined) {
      throw new WaError("a workflow call takes the run ctx as its first argument");
    }
    return compose(called, params) as Promise<R>;
  };
  const called = Object.assign(call, {
    description: definition.description,
    params: definition.params,
    run: definition.run,
  });
  return called;
}
