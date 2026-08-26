import { useCallback, useState } from "react";

import type { Attachment } from "@/lib/attachments";
import { appendInbox } from "@/lib/inbox";
import type { InboxEntry } from "@/lib/inbox";
import type { OutputLine } from "@/lib/runs";

export type Inbox = {
  /** Messages this app sent, by run. A run file never records them, so the transcript keeps them here. */
  sent: Record<string, OutputLine[]>;
  send: (runId: string, entry: InboxEntry, files: Attachment[]) => void;
  error: string | undefined;
};

/** The paths ride the message. The transcript draws them as previews instead. */
function echo(message: string, files: Attachment[]): string {
  const paths = new Set(files.map((file) => file.path));
  return message
    .split("\n")
    .filter((line) => !paths.has(line))
    .join("\n");
}

export function useInbox(): Inbox {
  const [sent, setSent] = useState<Record<string, OutputLine[]>>({});
  const [error, setError] = useState<string | undefined>(undefined);

  const send = useCallback((runId: string, entry: InboxEntry, files: Attachment[]) => {
    if ("message" in entry) {
      setSent((current) => {
        const before = current[runId] ?? [];
        const line: OutputLine = {
          id: `sent:${before.length}`,
          kind: "message",
          text: echo(entry.message, files),
          at: new Date().toISOString(),
          attachments: files,
        };
        return { ...current, [runId]: [...before, line] };
      });
    }
    appendInbox(runId, entry).then(
      () => setError(undefined),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, []);

  return { sent, send, error };
}
