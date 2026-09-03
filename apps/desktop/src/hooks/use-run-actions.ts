import { useCallback, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import { closeRuns, pauseRuns, renameRun, resumeRun, stopRuns } from "@/lib/run-files";
import { subtree, withDescendants } from "@/lib/runs";
import type { Run } from "@/lib/runs";

export type RunActions = {
  stop: (run: Run) => void;
  pause: (run: Run) => void;
  resume: (run: Run) => void;
  rename: (run: Run, name: string) => void;
  copyDir: (run: Run) => void;
  error: string | undefined;
};

function problem(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A running run is signalled; a parked one has no process, so its file takes the note. */
async function stopTree(run: Run): Promise<void> {
  const all = withDescendants(run);
  const live = all.filter((each) => each.status === "running").map((each) => each.id);
  const parked = all.filter((each) => each.status === "paused").map((each) => each.id);
  if (live.length > 0) await stopRuns(live);
  if (parked.length > 0) await closeRuns(parked);
}

/** What a run row's menu does. Each lands in the run's files, so the poller sees it. */
export function useRunActions(): RunActions {
  const [error, setError] = useState<string | undefined>(undefined);

  const watch = useCallback((work: Promise<unknown>) => {
    work.then(
      () => setError(undefined),
      (cause: unknown) => setError(problem(cause)),
    );
  }, []);

  return {
    stop: useCallback((run: Run) => watch(stopTree(run)), [watch]),
    pause: useCallback((run: Run) => watch(pauseRuns(subtree(run))), [watch]),
    resume: useCallback((run: Run) => watch(resumeRun(run.id)), [watch]),
    rename: useCallback((run: Run, name: string) => watch(renameRun(run.id, name)), [watch]),
    copyDir: useCallback((run: Run) => watch(writeText(run.dir)), [watch]),
    error,
  };
}
