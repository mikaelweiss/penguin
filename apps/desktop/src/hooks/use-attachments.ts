import { useCallback, useState } from "react";

import { attachPaste, attachPath } from "@/lib/attachments";
import type { Attachment } from "@/lib/attachments";

export type Attachments = {
  files: Attachment[];
  paste: (files: File[]) => void;
  drop: (paths: string[]) => void;
  remove: (file: Attachment) => void;
  clear: () => void;
  error: string | undefined;
};

function problem(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** What the input area holds until the message goes. */
export function useAttachments(runId: string): Attachments {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  const gather = useCallback((work: Promise<Attachment>[]) => {
    for (const one of work) {
      one.then(
        (file) => {
          setFiles((current) => [...current, file]);
          setError(undefined);
        },
        (cause: unknown) => setError(problem(cause)),
      );
    }
  }, []);

  return {
    files,
    paste: useCallback(
      (pasted: File[]) => gather(pasted.map((file) => attachPaste(runId, file))),
      [gather, runId],
    ),
    drop: useCallback((paths: string[]) => gather(paths.map((path) => attachPath(path))), [gather]),
    remove: useCallback((file: Attachment) => {
      if (file.thumbnail !== undefined) URL.revokeObjectURL(file.thumbnail);
      setFiles((current) => current.filter((held) => held.path !== file.path));
    }, []),
    // The sent message keeps the same previews, so their thumbnails outlive the input area.
    clear: useCallback(() => setFiles([]), []),
    error,
  };
}
