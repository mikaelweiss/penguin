import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** How long the run must stop writing before the patch is read again. */
const SETTLE_MS = 600;

export type RunDiff = {
  patch: string;
  /** What the patch is measured against: a remote branch in a worktree, else HEAD. */
  base: string;
  truncated: boolean;
};

export type DiffState = {
  diff: RunDiff | undefined;
  /** True once the directory is known to be outside any git repository. */
  plain: boolean;
  reading: boolean;
  error: string | undefined;
  reread: () => void;
};

/**
 * The run's patch, re-read once its output settles. Reading on every appended line would run git
 * against the whole worktree several times a second.
 */
export function useRunDiff(dir: string | undefined, wrote: number): DiffState {
  const [diff, setDiff] = useState<RunDiff | undefined>(undefined);
  const [plain, setPlain] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [asked, setAsked] = useState(0);
  const latest = useRef(0);
  const read = useRef<string | undefined>(undefined);

  const reread = useCallback(() => setAsked((count) => count + 1), []);

  useEffect(() => {
    setDiff(undefined);
    setPlain(false);
    setError(undefined);
    read.current = undefined;
  }, [dir]);

  useEffect(() => {
    if (dir === undefined) return;
    let dropped = false;

    const take = async () => {
      const ticket = latest.current + 1;
      latest.current = ticket;
      read.current = dir;
      setReading(true);
      try {
        const found = await invoke<RunDiff | null>("run_diff", { dir });
        if (dropped || latest.current !== ticket) return;
        setPlain(found === null);
        setDiff(found ?? undefined);
        setError(undefined);
      } catch (cause) {
        if (dropped || latest.current !== ticket) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!dropped) setReading(false);
      }
    };

    // The panel opens on the patch it already has. Only later writes wait for the run to settle.
    const timer = window.setTimeout(() => void take(), read.current === dir ? SETTLE_MS : 0);
    return () => {
      dropped = true;
      window.clearTimeout(timer);
    };
  }, [dir, wrote, asked]);

  return { diff, plain, reading, error, reread };
}
