import { invoke } from "@tauri-apps/api/core";

/** What a run's inbox takes: an answer settles its oldest question, a message reaches its listeners. */
export type InboxEntry = { answer: unknown } | { message: string };

export function appendInbox(id: string, entry: InboxEntry): Promise<void> {
  return invoke("append_inbox", { id, entry });
}
