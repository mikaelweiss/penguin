import { useEffect, useState } from "react";

import { readRunLog } from "@/lib/run-files";
import type { Run } from "@/lib/runs";

/** Why a crashed run left. A run that ended any other way says so in its own file. */
export function useRunLog(run: Run | undefined): string | undefined {
  const [log, setLog] = useState<string | undefined>(undefined);
  const id = run?.status === "crashed" ? run.id : undefined;

  useEffect(() => {
    if (id === undefined) {
      setLog(undefined);
      return;
    }
    let stopped = false;
    const take = (text: string) => {
      if (!stopped) setLog(text.trim() === "" ? undefined : text.trim());
    };
    readRunLog(id).then(take, () => take(""));
    return () => {
      stopped = true;
    };
  }, [id]);

  return log;
}
