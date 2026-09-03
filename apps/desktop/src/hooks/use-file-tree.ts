import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitStatusEntry } from "@pierre/trees";

import { directoryOf } from "@/lib/file-path";
import { listFiles, onFilesChanged, type FileEntry } from "@/lib/files";

export type FileTreeStore = {
  /** Every known path. Directories end in "/". Feeds FileTree.paths. */
  paths: string[];
  /** Ignored paths, as @pierre/trees entries. */
  ignored: GitStatusEntry[];
  /** Directories already listed, keyed without the trailing slash. */
  loaded: ReadonlySet<string>;
  error: string | undefined;
  /** Lists a directory once. A second call for a loaded directory is a no-op. */
  list: (dir: string) => void;
  /** Lists a directory again, whatever it already holds. */
  refresh: (dir: string) => void;
};

type Listing = {
  entries: ReadonlyMap<string, FileEntry>;
  children: ReadonlyMap<string, readonly string[]>;
  loaded: ReadonlySet<string>;
  error: string | undefined;
};

const NOTHING: Listing = {
  entries: new Map(),
  children: new Map(),
  loaded: new Set(),
  error: undefined,
};

/** A directory's key: root relative, no trailing slash. "" is the root. */
function dirKey(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * A directory's answer replaces what it held. Children that went away take their own
 * subtrees with them, so a removed folder cannot leave orphan rows behind.
 */
function replace(prev: Listing, dir: string, listing: readonly FileEntry[]): Listing {
  const entries = new Map(prev.entries);
  const children = new Map(prev.children);
  const loaded = new Set(prev.loaded);
  const next = listing.map((entry) => entry.path);
  const kept = new Set(next);

  for (const gone of prev.children.get(dir) ?? []) {
    if (kept.has(gone)) continue;
    entries.delete(gone);
    if (!gone.endsWith("/")) continue;
    const key = dirKey(gone);
    for (const path of prev.entries.keys()) if (path.startsWith(gone)) entries.delete(path);
    for (const path of prev.children.keys()) if (path === key || path.startsWith(gone)) children.delete(path);
    for (const path of prev.loaded) if (path === key || path.startsWith(gone)) loaded.delete(path);
  }

  for (const entry of listing) entries.set(entry.path, entry);
  children.set(dir, next);
  loaded.add(dir);
  return { entries, children, loaded, error: undefined };
}

/** Every directory the tree has listed, lazily, and what the watcher does to them. */
export function useFileTree(root: string | undefined): FileTreeStore {
  const [listing, setListing] = useState<Listing>(NOTHING);
  const held = useRef(listing);
  const scope = useRef<string | undefined>(undefined);
  const reading = useRef(new Set<string>());

  if (scope.current !== root) {
    scope.current = root;
    held.current = NOTHING;
    reading.current = new Set();
    setListing(NOTHING);
  }

  const read = useCallback((dir: string, force: boolean) => {
    const from = scope.current;
    if (from === undefined) return;
    const key = dirKey(dir);
    if (!force && held.current.loaded.has(key)) return;
    if (reading.current.has(key)) return;
    reading.current.add(key);

    const settle = (edit: (prev: Listing) => Listing) => {
      if (scope.current !== from) return;
      setListing((prev) => {
        const next = edit(prev);
        held.current = next;
        return next;
      });
    };

    listFiles(from, key)
      .then((entries) => settle((prev) => replace(prev, key, entries)))
      .catch((cause: unknown) => settle((prev) => ({ ...prev, error: message(cause) })))
      .finally(() => reading.current.delete(key));
  }, []);

  useEffect(() => {
    if (root === undefined) return;
    read("", false);
  }, [root, read]);

  useEffect(() => {
    if (root === undefined) return;
    let stop: (() => void) | undefined;
    let dropped = false;

    void onFilesChanged((changed) => {
      if (changed.root !== root) return;
      if (changed.overflow || changed.git) {
        for (const dir of held.current.loaded) read(dir, true);
        return;
      }
      for (const path of changed.paths) {
        const key = dirKey(path);
        if (held.current.loaded.has(key)) read(key, true);
        const parent = directoryOf(key);
        if (parent !== key && held.current.loaded.has(parent)) read(parent, true);
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
  }, [root, read]);

  const paths = useMemo(() => [...listing.entries.keys()].sort(), [listing.entries]);

  const ignored = useMemo<GitStatusEntry[]>(
    () =>
      [...listing.entries.values()]
        .filter((entry) => entry.ignored)
        .map((entry) => ({ path: entry.path, status: "ignored" })),
    [listing.entries],
  );

  const list = useCallback((dir: string) => read(dir, false), [read]);
  const refresh = useCallback((dir: string) => read(dir, true), [read]);

  return useMemo(
    () => ({ paths, ignored, loaded: listing.loaded, error: listing.error, list, refresh }),
    [paths, ignored, listing.loaded, listing.error, list, refresh],
  );
}
