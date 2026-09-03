import type { GitStatusEntry } from "@pierre/trees";

import type { FileChange, FileStatus } from "@/lib/files";

/** Case insensitive substring match on the whole path, opencode's filter. */
export function filterReviewFiles(files: string[], query: string): string[] {
  const value = query.trim().toLowerCase();
  if (value === "") return files;
  return files.filter((file) => file.toLowerCase().includes(value));
}

/** The badge opencode prints. */
export function statusLabel(status: FileStatus): string {
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  return "M";
}

/** What @pierre/trees paints a row with. */
export function statusEntries(files: readonly FileChange[]): GitStatusEntry[] {
  return files.map((file) => ({ path: file.file, status: file.status }));
}
