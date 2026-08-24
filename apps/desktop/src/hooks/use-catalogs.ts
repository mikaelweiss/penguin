import { useEffect, useState } from "react";

import { describe } from "@/lib/workflows";
import type { Catalogs } from "@/lib/workflows";

const NONE: Catalogs = { workflows: [], skills: [], adapters: [], errors: [] };

export type CatalogsRead = {
  catalogs: Catalogs;
  reading: boolean;
  error: string | undefined;
};

/** What one folder's catalogs hold, read again whenever the folder changes. */
export function useCatalogs(dir: string | undefined): CatalogsRead {
  const [catalogs, setCatalogs] = useState<Catalogs>(NONE);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (dir === undefined) return;
    let stopped = false;
    setCatalogs(NONE);
    setReading(true);
    describe(dir).then(
      (read) => {
        if (stopped) return;
        setCatalogs(read);
        setError(read.errors[0]);
        setReading(false);
      },
      (cause: unknown) => {
        if (stopped) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setReading(false);
      },
    );
    return () => {
      stopped = true;
    };
  }, [dir]);

  return { catalogs, reading, error };
}
