import { useCallback, useState } from "react";

import type { Directories } from "@/hooks/use-directories";
import { forgetRuns } from "@/lib/run-files";
import { subtree } from "@/lib/runs";
import type { Project } from "@/lib/runs";

export type RemoveProject = {
  /** The project the confirmation settles. The dialog is open whenever there is one. */
  asking: Project | undefined;
  ask: (dir: string) => void;
  cancel: () => void;
  hide: () => void;
  deleteRuns: () => void;
  error: string | undefined;
};

function problem(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Taking a project off the sidebar, which means its directory and the runs that name it as root. */
export function useRemoveProject(
  projects: Project[],
  directories: Directories,
): RemoveProject {
  const [asking, setAsking] = useState<Project | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const ask = useCallback(
    (dir: string) => {
      const project = projects.find((current) => current.dir === dir);
      setAsking(project ?? { id: dir, name: dir, dir, runs: [] });
    },
    [projects],
  );

  const cancel = useCallback(() => setAsking(undefined), []);

  const hide = useCallback(() => {
    if (asking !== undefined) directories.hide(asking.dir);
    setAsking(undefined);
  }, [asking, directories]);

  const deleteRuns = useCallback(() => {
    if (asking === undefined) return;
    const ids = asking.runs.flatMap(subtree);
    // Hidden as well as deleted, so the project does not flicker back while the runs are stopping.
    directories.hide(asking.dir);
    setAsking(undefined);
    if (ids.length === 0) return;
    forgetRuns(ids).then(
      () => setError(undefined),
      (cause: unknown) => setError(problem(cause)),
    );
  }, [asking, directories]);

  return { asking, ask, cancel, hide, deleteRuns, error };
}
