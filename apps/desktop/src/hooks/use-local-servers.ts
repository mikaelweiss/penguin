import { useEffect, useState } from "react";

import { localServers, type LocalServer } from "@/lib/servers";

const POLL_MS = 3000;

/** The local web servers running right now. Polled only while something is looking. */
export function useLocalServers(looking: boolean): LocalServer[] {
  const [servers, setServers] = useState<LocalServer[]>([]);

  useEffect(() => {
    if (!looking) return;
    let stopped = false;
    let timer: number | undefined;
    // A scan runs lsof and fetches every port it found, so the next one waits for this one.
    const scan = () => {
      localServers().then(
        (found) => {
          if (stopped) return;
          setServers(found);
          timer = window.setTimeout(scan, POLL_MS);
        },
        () => {
          if (!stopped) timer = window.setTimeout(scan, POLL_MS);
        },
      );
    };
    scan();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [looking]);

  return servers;
}
