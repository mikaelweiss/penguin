import { useEffect, useState } from "react";

import type { Hidden } from "@/lib/directories";
import { readRuns } from "@/lib/run-files";
import { parseEntries, toProjects } from "@/lib/runs";
import type { Project, RunFile } from "@/lib/runs";

const POLL_MS = 250;

/** Settled once a read has reached the file's end, so its closing note is in hand. */
type Tracked = RunFile & { offset: number; settled: boolean };

export type Runs = {
  projects: Project[];
  /** False until every run file has been read to its end once. A half-read tree is not acted on. */
  published: boolean;
  error: string | undefined;
};

/**
 * Follows every run file, re-reading only the bytes each one has grown by. A file the budget cut
 * short stays out of the tree until a read reaches its end: without its closing note, a finished
 * run would pass for a paused one.
 */
export function useRuns(dirs: string[], hidden: Hidden): Runs {
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
        // A file that shrank was re-read from its start, so its old entries would double up.
        const rewound = prior !== undefined && update.offset < prior.offset;
        if (prior === undefined || update.text !== "" || prior.alive !== update.alive || rewound) {
          changed = true;
        }
        const entries = rewound || prior === undefined ? [] : prior.entries;
        if (update.text !== "") entries.push(...parseEntries(update.text));
        const settled = (!rewound && prior?.settled === true) || !update.more;
        if (prior?.settled !== settled) changed = true;
        next.set(update.id, {
          id: update.id,
          entries,
          alive: update.alive,
          offset: update.offset,
          settled,
        });
      }

      tracked = next;
      if (!changed) return;
      drawn = true;
      const files = [...next.values()];
      setProjects(toProjects(files.filter((file) => file.settled), dirs, hidden));
      if (files.every((file) => file.settled)) setPublished(true);
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
  }, [dirs, hidden]);

  return { projects, published, error };
}
