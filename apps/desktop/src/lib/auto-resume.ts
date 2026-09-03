import type { Paused, Project, Run } from "@/lib/runs";

/** How long to wait before trying again when no reset time is known, it has passed, or a resume failed. */
export const RETRY_MS = 5 * 60_000;

/** A moment past the reset, so the first turn after it lands inside the new window. */
export const SLACK_MS = 1000;

/** When a limit-paused run comes back. A reset time already behind us proved nothing, so it waits like none. */
export function dueAt(paused: Paused, now: number): number {
  const until = Date.parse(paused.until ?? "");
  if (Number.isFinite(until) && until > now) return until + SLACK_MS;
  return now + RETRY_MS;
}

/** The root runs a usage limit parked. A run inside a paused tree comes back with its root. */
export function limitPaused(projects: Project[]): Map<string, Run> {
  const found = new Map<string, Run>();
  for (const project of projects) {
    for (const run of project.runs) {
      if (run.status === "paused" && run.paused?.by === "limit") found.set(run.id, run);
    }
  }
  return found;
}
