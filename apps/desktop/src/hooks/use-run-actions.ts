import { useCallback, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import { renameRun, stopRuns } from "@/lib/run-files";
import { subtree } from "@/lib/runs";
import type { Run } from "@/lib/runs";

export type RunActions = {
  stop: (run: Run) => void;
  rename: (run: Run, name: string) => void;
  copyDir: (run: Run) => void;
  error: string | undefined;
};

function problem(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** What a run row's menu does. Stop and rename land in the run's files, so the poller sees them. */
export function useRunActions(): RunActions {
  const [error, setError] = useState<string | undefined>(undefined);

  const watch = useCallback((work: Promise<unknown>) => {
    work.then(
      () => setError(undefined),
      (cause: unknown) => setError(problem(cause)),
    );
  }, []);

  return {
    stop: useCallback((run: Run) => watch(stopRuns(subtree(run))), [watch]),
    rename: useCallback((run: Run, name: string) => watch(renameRun(run.id, name)), [watch]),
    copyDir: useCallback((run: Run) => watch(writeText(run.dir)), [watch]),
    error,
  };
}
