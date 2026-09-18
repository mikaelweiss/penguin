import { openPath, openUrl } from "@tauri-apps/plugin-opener";

import { filePath } from "@/lib/browser";

/** Hands a page to whatever the machine opens it with. A brief is a file on disk, not a url. */
export function openOutside(url: string): Promise<void> {
  const path = filePath(url);
  return path === undefined ? openUrl(url) : openPath(path);
}
