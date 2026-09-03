import { useEffect, useState } from "react";

import { plain } from "@/lib/ansi";
import { readRunLog } from "@/lib/run-files";
import type { Run } from "@/lib/runs";

/** Why an interrupted run's process left. A run that ended any other way says so in its own file. */
export function useRunLog(run: Run | undefined): string | undefined {
  const [log, setLog] = useState<string | undefined>(undefined);
  const id = run?.paused?.by === "interrupted" ? run.id : undefined;

  useEffect(() => {
    if (id === undefined) {
      setLog(undefined);
      return;
    }
    let stopped = false;
    const take = (raw: string) => {
      const text = plain(raw).trim();
      if (!stopped) setLog(text === "" ? undefined : text);
    };
    readRunLog(id).then(take, () => take(""));
    return () => {
      stopped = true;
    };
  }, [id]);

  return log;
}
