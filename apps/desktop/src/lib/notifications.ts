import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

/** Rust emits this with the run id when someone clicks a needs-you notification. */
const NEEDS_YOU_CLICK = "needs-you-click";

export function notifyNeedsYou(id: string, title: string, body: string): Promise<void> {
  return invoke("notify_needs_you", { id, title, body });
}

export function onNeedsYouClick(handler: (id: string) => void): Promise<UnlistenFn> {
  return listen<string>(NEEDS_YOU_CLICK, (event) => handler(event.payload));
}
