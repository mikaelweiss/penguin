import { useEffect, useState } from "react";

import { ended, readGates, writeGates } from "@/lib/gates";

export type GatesFile = {
  /** What the person is editing, undefined until the project has a file or they start one. */
  draft: string | undefined;
  edit: (next: string) => void;
  /** Opens an empty draft for a project whose gate file does not exist yet. */
  start: () => void;
  save: () => void;
  reading: boolean;
  saving: boolean;
  /** Whether the draft says something the file does not. */
  dirty: boolean;
  error: string | undefined;
};

function detailOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** One project's gate file, read again whenever the project changes and written whole. */
export function useGates(dir: string | undefined): GatesFile {
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (dir === undefined) return;
    let stopped = false;
    setSaved(undefined);
    setDraft(undefined);
    setError(undefined);
    setReading(true);
    readGates(dir).then(
      (text) => {
        if (stopped) return;
        setSaved(text);
        setDraft(text);
        setReading(false);
      },
      (cause: unknown) => {
        if (stopped) return;
        setError(detailOf(cause));
        setReading(false);
      },
    );
    return () => {
      stopped = true;
    };
  }, [dir]);

  const save = () => {
    if (dir === undefined || draft === undefined) return;
    const writing = ended(draft);
    setSaving(true);
    writeGates(dir, draft).then(
      () => {
        setSaved(writing);
        setDraft(writing);
        setError(undefined);
        setSaving(false);
      },
      (cause: unknown) => {
        setError(detailOf(cause));
        setSaving(false);
      },
    );
  };

  return {
    draft,
    edit: setDraft,
    start: () => setDraft(""),
    save,
    reading,
    saving,
    dirty: draft !== undefined && draft !== saved,
    error,
  };
}
