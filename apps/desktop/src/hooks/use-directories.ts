import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { projectRoot, readDirs, readHidden, writeDirs, writeHidden } from "@/lib/directories";
import type { Hidden } from "@/lib/directories";

export type Directories = {
  dirs: string[];
  hidden: Hidden;
  add: () => void;
  /** Drops the directory and hides the runs it holds today. A newer run brings the project back. */
  hide: (dir: string) => void;
  error: string | undefined;
};

function problem(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function without(hidden: Hidden, dir: string): Hidden {
  const next = { ...hidden };
  delete next[dir];
  return next;
}

/** The project folders the sidebar lists, kept in the app's own config beside the theme. */
export function useDirectories(): Directories {
  const [dirs, setDirs] = useState<string[]>([]);
  const [hidden, setHidden] = useState<Hidden>({});
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    readDirs().then(setDirs, (cause: unknown) => setError(problem(cause)));
    readHidden().then(setHidden, (cause: unknown) => setError(problem(cause)));
  }, []);

  const save = useCallback((nextDirs: string[], nextHidden: Hidden) => {
    setDirs(nextDirs);
    setHidden(nextHidden);
    Promise.all([writeDirs(nextDirs), writeHidden(nextHidden)]).then(
      () => setError(undefined),
      (cause: unknown) => setError(problem(cause)),
    );
  }, []);

  const add = useCallback(() => {
    const pick = async () => {
      const picked = await open({ directory: true, title: "Add a project directory" });
      if (typeof picked !== "string") return;
      // Runs group under their git root, so the row the user gets is that root, not the folder.
      const root = await projectRoot(picked);
      // Adding a project back is asking for its runs again, so it stops being hidden.
      save(dirs.includes(root) ? dirs : [...dirs, root], without(hidden, root));
    };
    pick().catch((cause: unknown) => setError(problem(cause)));
  }, [dirs, hidden, save]);

  const hide = useCallback(
    (dir: string) =>
      save(dirs.filter((current) => current !== dir), {
        ...hidden,
        [dir]: new Date().toISOString(),
      }),
    [dirs, hidden, save],
  );

  return { dirs, hidden, add, hide, error };
}
