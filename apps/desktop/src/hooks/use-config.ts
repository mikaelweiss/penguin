import { useEffect, useState } from "react";

import { readConfig, writeConfig } from "@/lib/config";

export type Config = {
  values: Record<string, string>;
  set: (key: string, value: string) => void;
  error: string | undefined;
};

function detailOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The shared config, read once and written a setting at a time. */
export function useConfig(): Config {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let stopped = false;
    readConfig().then(
      (read) => {
        if (!stopped) setValues(read);
      },
      (cause: unknown) => {
        if (!stopped) setError(detailOf(cause));
      },
    );
    return () => {
      stopped = true;
    };
  }, []);

  const set = (key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    writeConfig(key, value).then(
      () => setError(undefined),
      (cause: unknown) => setError(detailOf(cause)),
    );
  };

  return { values, set, error };
}
