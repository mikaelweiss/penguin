import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";

import { useDark } from "@/hooks/use-dark";
import { diffTheme } from "@/lib/diff";
import type { DiffTheme } from "@/lib/diff";

const MIN_WORKERS = 2;
const MAX_WORKERS = 6;

function ThemeSync({ theme }: { theme: DiffTheme }) {
  const pool = useWorkerPool();

  useEffect(() => {
    if (pool === null || pool === undefined) return;
    const held = pool.getDiffRenderOptions();
    if (held.theme === theme) return;
    void pool.setRenderOptions({ ...held, theme }).catch(() => {});
  }, [pool, theme]);

  return null;
}

/** Syntax highlighting runs off the main thread, so a large patch never stalls the transcript. */
export function DiffWorkerPool({ children }: { children: ReactNode }) {
  const theme = diffTheme(useDark());
  const size = useMemo(() => {
    const cores = Math.max(1, navigator.hardwareConcurrency || 4);
    return Math.max(MIN_WORKERS, Math.min(MAX_WORKERS, Math.floor(cores / 2)));
  }, []);

  return (
    <WorkerPoolContextProvider
      poolOptions={{ workerFactory: () => new DiffsWorker(), poolSize: size }}
      highlighterOptions={{ theme, tokenizeMaxLineLength: 1_000, useTokenTransformer: true }}
    >
      <ThemeSync theme={theme} />
      {children}
    </WorkerPoolContextProvider>
  );
}
