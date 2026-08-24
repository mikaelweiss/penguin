import { useEffect, useState } from "react";

import { readRuns } from "@/lib/run-files";
import { parseEntries, toProjects } from "@/lib/runs";
import type { Project, RunFile } from "@/lib/runs";

const POLL_MS = 250;

type Tracked = RunFile & { offset: number };

export type Runs = {
  projects: Project[];
  error: string | undefined;
};

/** Follows every run file, re-reading only the bytes each one has grown by. */
export function useRuns(): Runs {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let tracked = new Map<string, Tracked>();
    let stopped = false;
    let timer = 0;

    const tick = async () => {
      const offsets: Record<string, number> = {};
      for (const [id, file] of tracked) offsets[id] = file.offset;

      const updates = await readRuns(offsets);
      let changed = updates.length !== tracked.size;

      const next = new Map<string, Tracked>();
      for (const update of updates) {
        const prior = tracked.get(update.id);
        if (prior === undefined || update.text !== "" || prior.alive !== update.alive) {
          changed = true;
        }
        const entries = prior?.entries ?? [];
        if (update.text !== "") entries.push(...parseEntries(update.text));
        next.set(update.id, {
          id: update.id,
          entries,
          alive: update.alive,
          offset: update.offset,
        });
      }

      tracked = next;
      if (changed) setProjects(toProjects([...next.values()]));
    };

    const loop = async () => {
      try {
        await tick();
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      if (!stopped) timer = window.setTimeout(() => void loop(), POLL_MS);
    };
    void loop();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);

  return { projects, error };
}
