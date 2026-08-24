import { useCallback, useState } from "react";

import { appendInbox } from "@/lib/inbox";
import type { InboxEntry } from "@/lib/inbox";
import type { OutputLine } from "@/lib/runs";

export type Inbox = {
  /** Messages this app sent, by run. A run file never records them, so the transcript keeps them here. */
  sent: Record<string, OutputLine[]>;
  send: (runId: string, entry: InboxEntry) => void;
  error: string | undefined;
};

export function useInbox(): Inbox {
  const [sent, setSent] = useState<Record<string, OutputLine[]>>({});
  const [error, setError] = useState<string | undefined>(undefined);

  const send = useCallback((runId: string, entry: InboxEntry) => {
    if ("message" in entry) {
      const line: OutputLine = {
        kind: "message",
        text: entry.message,
        at: new Date().toISOString(),
      };
      setSent((current) => ({ ...current, [runId]: [...(current[runId] ?? []), line] }));
    }
    appendInbox(runId, entry).then(
      () => setError(undefined),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, []);

  return { sent, send, error };
}
