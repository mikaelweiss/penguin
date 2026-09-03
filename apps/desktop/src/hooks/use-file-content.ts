import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { onFilesChanged, readFile, type FileContent } from "@/lib/files";

export type FileState = {
  content: FileContent | undefined;
  loading: boolean;
  error: string | undefined;
};

export type FileContentStore = {
  get: (path: string) => FileState | undefined;
  /** Reads once. force re-reads whatever is cached. */
  load: (path: string, options?: { force?: boolean }) => void;
  /** Paths whose tabs are open, so the watcher knows what to re-read. */
  setOpen: (paths: readonly string[]) => void;
};

const NOTHING: ReadonlyMap<string, FileState> = new Map();

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Every file the panel has read, kept until the root moves and re-read when it changes on disk. */
export function useFileContent(root: string | undefined): FileContentStore {
  const [files, setFiles] = useState<ReadonlyMap<string, FileState>>(NOTHING);
  const held = useRef(files);
  const scope = useRef<string | undefined>(undefined);
  const reading = useRef(new Set<string>());
  const open = useRef<readonly string[]>([]);

  if (scope.current !== root) {
    scope.current = root;
    held.current = NOTHING;
    reading.current = new Set();
    setFiles(NOTHING);
  }

  const load = useCallback((path: string, options?: { force?: boolean }) => {
    const from = scope.current;
    if (from === undefined || path === "") return;
    if (options?.force !== true && held.current.has(path)) return;
    if (reading.current.has(path)) return;
    reading.current.add(path);

    const settle = (state: FileState) => {
      if (scope.current !== from) return;
      setFiles((prev) => {
        const next = new Map(prev);
        next.set(path, state);
        held.current = next;
        return next;
      });
    };

    settle({ content: held.current.get(path)?.content, loading: true, error: undefined });

    readFile(from, path)
      .then((content) => settle({ content, loading: false, error: undefined }))
      .catch((cause: unknown) =>
        settle({ content: undefined, loading: false, error: message(cause) }),
      )
      .finally(() => reading.current.delete(path));
  }, []);

  const setOpen = useCallback((paths: readonly string[]) => {
    open.current = paths;
  }, []);

  useEffect(() => {
    if (root === undefined) return;
    let stop: (() => void) | undefined;
    let dropped = false;

    void onFilesChanged((changed) => {
      if (changed.root !== root) return;
      if (changed.overflow) {
        for (const path of open.current) load(path, { force: true });
        return;
      }
      for (const path of changed.paths) {
        if (!held.current.has(path) && !open.current.includes(path)) continue;
        load(path, { force: true });
      }
    }).then((unlisten) => {
      if (dropped) {
        unlisten();
        return;
      }
      stop = unlisten;
    });

    return () => {
      dropped = true;
      stop?.();
    };
  }, [root, load]);

  const get = useCallback((path: string) => files.get(path), [files]);

  return useMemo(() => ({ get, load, setOpen }), [get, load, setOpen]);
}
