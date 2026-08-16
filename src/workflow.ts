import type { z } from "zod";
import { WaError } from "./errors.ts";
import type { Workflow } from "./types.ts";

export function workflow<Schema extends z.ZodObject>(
  definition: Workflow<Schema>,
): Workflow<Schema> {
  if (typeof definition.description !== "string" || definition.description.trim() === "") {
    throw new WaError("a workflow needs a description");
  }
  return definition;
}
