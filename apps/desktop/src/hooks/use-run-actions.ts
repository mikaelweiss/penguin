import { useCallback, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import { pauseRuns, renameRun, resumeRun, stopRuns } from "@/lib/run-files";
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
    // The runs inside this one are found from their folders, not from these rows: a row the window
    // has not drawn yet still has a process, and an action that cannot see it leaves it running.
    stop: useCallback((run: Run) => watch(stopRuns([run.id])), [watch]),
    pause: useCallback((run: Run) => watch(pauseRuns([run.id])), [watch]),
    resume: useCallback((run: Run) => watch(resumeRun(run.id)), [watch]),
    rename: useCallback((run: Run, name: string) => watch(renameRun(run.id, name)), [watch]),
    copyDir: useCallback((run: Run) => watch(writeText(run.dir)), [watch]),
    error,
  };
}
