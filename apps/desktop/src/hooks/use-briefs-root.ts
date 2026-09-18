import { useEffect, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";

import { briefsRoot } from "@/lib/briefs";

/**
 * Where the engine writes a run's pages and pictures. Undefined until the home folder answers,
 * and empty when it never will: the tree waits on this, so a failure has to be an answer too.
 */
export function useBriefsRoot(): string | undefined {
  const [root, setRoot] = useState<string | undefined>(undefined);

  useEffect(() => {
    homeDir().then(
      (home) => setRoot(briefsRoot(home)),
      () => setRoot(""),
    );
  }, []);

  return root;
}
