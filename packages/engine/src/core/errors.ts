import type { z } from "zod";

export class PenguinError extends Error {}

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
