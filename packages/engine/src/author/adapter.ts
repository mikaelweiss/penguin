import { PenguinError } from "../errors.ts";
import type { Adapter } from "./host.ts";

export function adapter<A>(definition: Adapter<A>): Adapter<A> {
  for (const field of ["role", "name", "description"] as const) {
    if (typeof definition[field] !== "string" || definition[field].trim() === "") {
      throw new PenguinError(`an adapter needs a ${field}`);
    }
  }
  if (typeof definition.build !== "function") {
    throw new PenguinError("an adapter needs a build function");
  }
  return definition;
}
