import type { z } from "zod";
import type { Workflow } from "./types.ts";

export function workflow<Schema extends z.ZodObject>(
  definition: Workflow<Schema>,
): Workflow<Schema> {
  return definition;
}
