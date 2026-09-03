import { useEffect, useRef } from "react";

import { dueAt, limitPaused } from "@/lib/auto-resume";
import { resumeRun } from "@/lib/run-files";
import type { Project } from "@/lib/runs";

/** The longest one timer sleeps. A far reset is reached in hops, each one looking at the clock again. */
const HOP_MS = 60 * 60_000;

type Scheduled = { pausedAt: string; timer: number };

/** Brings back every root run a usage limit parked, once the limit clears. */
export function useAutoResume(projects: Project[], published: boolean): void {
  const scheduled = useRef(new Map<string, Scheduled>());
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const held = scheduled.current;
    return () => {
      mounted.current = false;
      for (const entry of held.values()) window.clearTimeout(entry.timer);
      held.clear();
    };
  }, []);

  useEffect(() => {
    if (!published) return;
    const held = scheduled.current;
    const wanted = limitPaused(projects);

    for (const [id, entry] of held) {
      if (wanted.get(id)?.paused?.at === entry.pausedAt) continue;
      window.clearTimeout(entry.timer);
      held.delete(id);
    }

    for (const [id, run] of wanted) {
      const paused = run.paused;
      if (held.has(id) || paused === undefined) continue;
      const pausedAt = paused.at;
      // The pause a timer was set for has to still stand each time the timer looks.
      const stands = (): boolean => mounted.current && held.get(id)?.pausedAt === pausedAt;
      const wait = (): void => {
        if (!stands()) return;
        const now = Date.now();
        const left = dueAt(paused, now) - now;
        const next = left > HOP_MS ? wait : fire;
        held.set(id, { pausedAt, timer: window.setTimeout(next, Math.min(left, HOP_MS)) });
      };
      // Whatever the attempt did, it waits again: a pause that changed or ended is dropped
      // above on the next poll, and one that did not is tried once more.
      const fire = (): void => {
        if (!stands()) return;
        resumeRun(id, true).then(wait, wait);
      };
      held.set(id, { pausedAt, timer: 0 });
      wait();
    }
  }, [projects, published]);
}
