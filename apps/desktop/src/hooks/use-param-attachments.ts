import { useCallback, useState } from "react";

import { attachPaste } from "@/lib/attachments";
import type { Attachment } from "@/lib/attachments";

export type ParamAttachments = {
  files: Record<string, Attachment[]>;
  paste: (name: string, files: File[]) => void;
  remove: (name: string, file: Attachment) => void;
  reset: () => void;
  error: string | undefined;
};

function problem(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** What the params form holds per param until the run starts. */
export function useParamAttachments(claim: () => Promise<string>): ParamAttachments {
  const [files, setFiles] = useState<Record<string, Attachment[]>>({});
  const [error, setError] = useState<string | undefined>(undefined);

  const reset = useCallback(() => {
    for (const held of Object.values(files).flat()) {
      if (held.thumbnail !== undefined) URL.revokeObjectURL(held.thumbnail);
    }
    setFiles({});
    setError(undefined);
  }, [files]);

  return {
    files,
    paste: useCallback(
      (name: string, pasted: File[]) => {
        for (const file of pasted) {
          claim()
            .then((id) => attachPaste(id, file))
            .then(
              (attached) => {
                setFiles((current) => ({
                  ...current,
                  [name]: [...(current[name] ?? []), attached],
                }));
                setError(undefined);
              },
              (cause: unknown) => setError(problem(cause)),
            );
        }
      },
      [claim],
    ),
    remove: useCallback((name: string, file: Attachment) => {
      if (file.thumbnail !== undefined) URL.revokeObjectURL(file.thumbnail);
      setFiles((current) => ({
        ...current,
        [name]: (current[name] ?? []).filter((held) => held.path !== file.path),
      }));
    }, []),
    reset,
    error,
  };
}
