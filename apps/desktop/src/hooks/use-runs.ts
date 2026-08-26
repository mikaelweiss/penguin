import { useEffect, useState } from "react";

import { readRuns } from "@/lib/run-files";
import { parseEntries, toProjects } from "@/lib/runs";
import type { Project, RunFile } from "@/lib/runs";

const POLL_MS = 250;

type Tracked = RunFile & { offset: number };

export type Runs = {
  projects: Project[];
  /** False until the first tree lands, so an empty first render is not read as no runs. */
  published: boolean;
  error: string | undefined;
};

/** Follows every run file, re-reading only the bytes each one has grown by. */
export function useRuns(dirs: string[]): Runs {
  const [projects, setProjects] = useState<Project[]>([]);
  const [published, setPublished] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let tracked = new Map<string, Tracked>();
    let drawn = false;
    let stopped = false;
    let timer = 0;

    const tick = async () => {
      const offsets: Record<string, number> = {};
      for (const [id, file] of tracked) offsets[id] = file.offset;

      const updates = await readRuns(offsets);
      // These directories are new, so they need a first draw even when no run file has grown.
      let changed = !drawn || updates.length !== tracked.size;

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
      if (!changed) return;
      drawn = true;
      setProjects(toProjects([...next.values()], dirs));
      setPublished(true);
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
  }, [dirs]);

  return { projects, published, error };
}
