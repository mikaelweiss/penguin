import { useEffect } from "react";

import { watchFiles } from "@/lib/files";

/** Keeps the native watcher pointed at the selected run's root. */
export function useWatchRoot(root: string | undefined): void {
  // A second call replaces the watch, so a root change is one call. Stopping between the two would
  // leave the order of two invokes deciding whether anything is watched at all.
  useEffect(() => {
    watchFiles(root).catch(() => {});
  }, [root]);

  useEffect(
    () => () => {
      watchFiles(undefined).catch(() => {});
    },
    [],
  );
}
