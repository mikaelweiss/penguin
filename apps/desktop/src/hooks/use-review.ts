import { useCallback, useEffect, useSyncExternalStore } from "react";

import { gitChanges, onFilesChanged } from "@/lib/files";
import type { BaseChoice, FileChange } from "@/lib/files";

/** How long the tree must be quiet before the changes are read again. */
const SETTLE_MS = 150;

export type ReviewStat = { files: number; additions: number; deletions: number };

export type ReviewState = {
  git: boolean;
  /** What the toolbar prints. "" until the first read lands. */
  base: string;
  files: FileChange[];
  /** Sum over files. */
  stat: ReviewStat;
  /** False until the first read for this root and base has landed. */
  ready: boolean;
  truncated: boolean;
  error: string | undefined;
};

const EMPTY: ReviewState = {
  git: true,
  base: "",
  files: [],
  stat: { files: 0, additions: 0, deletions: 0 },
  ready: false,
  truncated: false,
  error: undefined,
};

type Reading = {
  state: ReviewState;
  listeners: Set<() => void>;
  /** An answer from an earlier ticket is dropped. */
  ticket: number;
  settle: number | undefined;
};

/**
 * One reading per root and base, so the Review tab and the Info panel quote the same figures from
 * the same git run rather than from two runs that can disagree.
 */
const readings = new Map<string, Reading>();

function keyOf(root: string, base: BaseChoice): string {
  return `${root} ${base}`;
}

function statOf(files: readonly FileChange[]): ReviewStat {
  return files.reduce<ReviewStat>(
    (total, file) => ({
      files: total.files + 1,
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

function publish(reading: Reading, state: ReviewState): void {
  reading.state = state;
  for (const listener of reading.listeners) listener();
}

async function read(key: string, root: string, base: BaseChoice): Promise<void> {
  const reading = readings.get(key);
  if (reading === undefined) return;
  reading.ticket += 1;
  const ticket = reading.ticket;

  try {
    const changes = await gitChanges(root, base);
    if (readings.get(key) !== reading || reading.ticket !== ticket) return;
    publish(reading, {
      git: changes.git,
      base: changes.base,
      files: changes.files,
      stat: statOf(changes.files),
      ready: true,
      truncated: changes.truncated,
      error: undefined,
    });
  } catch (cause) {
    if (readings.get(key) !== reading || reading.ticket !== ticket) return;
    publish(reading, {
      ...reading.state,
      ready: true,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/** A burst that survived the native debounce still costs one git run. */
function schedule(key: string, root: string, base: BaseChoice): void {
  const reading = readings.get(key);
  if (reading === undefined) return;
  if (reading.settle !== undefined) window.clearTimeout(reading.settle);
  reading.settle = window.setTimeout(() => {
    reading.settle = undefined;
    void read(key, root, base);
  }, SETTLE_MS);
}

/** Every file that differs from the base, re-read whenever the tree moves. */
export function useReview(root: string | undefined, base: BaseChoice): ReviewState {
  const key = root === undefined ? undefined : keyOf(root, base);

  const subscribe = useCallback(
    (listener: () => void) => {
      if (key === undefined || root === undefined) return () => {};

      const held = readings.get(key) ?? {
        state: EMPTY,
        listeners: new Set<() => void>(),
        ticket: 0,
        settle: undefined,
      };
      if (!readings.has(key)) {
        readings.set(key, held);
        void read(key, root, base);
      }
      held.listeners.add(listener);

      return () => {
        held.listeners.delete(listener);
        if (held.listeners.size > 0) return;
        if (held.settle !== undefined) window.clearTimeout(held.settle);
        if (readings.get(key) === held) readings.delete(key);
      };
    },
    [key, root, base],
  );

  const snapshot = useCallback(
    () => (key === undefined ? EMPTY : (readings.get(key)?.state ?? EMPTY)),
    [key],
  );

  useEffect(() => {
    if (key === undefined || root === undefined) return;
    let dropped = false;
    const stop = onFilesChanged((changed) => {
      if (dropped || changed.root !== root) return;
      schedule(key, root, base);
    });
    return () => {
      dropped = true;
      stop.then((off) => off()).catch(() => {});
    };
  }, [key, root, base]);

  return useSyncExternalStore(subscribe, snapshot);
}
