import type { z } from "zod";

export class PenguinError extends Error {}

/**
 * The world refused a call: a network, a tool, or the state of a repo stopped it,
 * and clearing that makes the same call worth running again. The engine catches a
 * Fault at the adapter boundary and holds the run at a gate instead of ending it.
 * `fix: "agent"` sends it to a fixer agent before the person.
 */
export class Fault extends PenguinError {
  readonly fix: "agent" | "person";
  constructor(message: string, options?: { fix?: "agent" | "person" }) {
    super(message);
    this.fix = options?.fix ?? "person";
  }
}

/** A sub-run's process was told to stop, by a person or a parent. */
export class RunStopped extends PenguinError {}

/** A sub-run's process died without recording an outcome. */
export class RunCrashed extends PenguinError {}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** One line naming every issue in a zod error, for a person to read. */
export function issuesOf(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.join(".");
      return at === "" ? issue.message : `${at}: ${issue.message}`;
    })
    .join(", ");
}
