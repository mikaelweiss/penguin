import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { projectRoot, readDirs, writeDirs } from "@/lib/directories";

export type Directories = {
  dirs: string[];
  add: () => void;
  remove: (dir: string) => void;
  error: string | undefined;
};

function problem(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The project folders the sidebar lists, kept in the app's own config beside the theme. */
export function useDirectories(): Directories {
  const [dirs, setDirs] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    readDirs().then(setDirs, (cause: unknown) => setError(problem(cause)));
  }, []);

  const save = useCallback((next: string[]) => {
    setDirs(next);
    writeDirs(next).then(
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
      if (!dirs.includes(root)) save([...dirs, root]);
    };
    pick().catch((cause: unknown) => setError(problem(cause)));
  }, [dirs, save]);

  const remove = useCallback(
    (dir: string) => save(dirs.filter((current) => current !== dir)),
    [dirs, save],
  );

  return { dirs, add, remove, error };
}
