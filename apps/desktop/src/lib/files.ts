import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { PanelStore } from "@/hooks/use-panels";

/** Which commit the review measures from. "auto" is what the run itself picks. */
export type BaseChoice = "auto" | "head" | "branch";

export type ReviewRoot = {
  /** The work tree the review covers. A folder outside git is its own root. */
  root: string;
  git: boolean;
  /** A remote ref, for example "origin/main". */
  defaultBranch: string | null;
};

export type FileStatus = "added" | "deleted" | "modified";

export type FileChange = {
  /** Root relative, forward slashes. */
  file: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** A whole file context unified diff. Empty when binary or truncated. */
  patch: string;
  binary: boolean;
  truncated: boolean;
};

export type GitChanges = {
  git: boolean;
  /** What the toolbar prints, for example "HEAD" or "origin/main". */
  base: string;
  rev: string;
  files: FileChange[];
  truncated: boolean;
};

export type FileEntry = {
  name: string;
  /** Root relative, forward slashes. A directory ends in "/". */
  path: string;
  type: "file" | "directory";
  ignored: boolean;
};

export type FileContent = {
  kind: "text" | "binary" | "large" | "missing";
  text: string;
  bytes: number;
};

export type FilesChanged = {
  root: string;
  /** Root relative, forward slashes. Empty when overflow is true. */
  paths: string[];
  overflow: boolean;
  git: boolean;
};

/** The work tree a run reviews, and what its base picker can offer. */
export function reviewRoot(dir: string): Promise<ReviewRoot> {
  return invoke<ReviewRoot>("review_root", { dir });
}

export function gitChanges(root: string, base: BaseChoice): Promise<GitChanges> {
  return invoke<GitChanges>("git_changes", { root, base });
}

/** One directory's entries. dir is root relative. "" is the root. */
export function listFiles(root: string, dir: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("list_files", { root, dir });
}

export function readFile(root: string, path: string): Promise<FileContent> {
  return invoke<FileContent>("read_file", { root, path });
}

/** Root relative paths matching the query, best first. An empty query matches nothing. */
export function searchFiles(root: string, query: string, limit: number): Promise<string[]> {
  return invoke<string[]>("search_files", { root, query, limit });
}

/** Watches one root. A second call replaces the first. undefined stops watching. */
export function watchFiles(root: string | undefined): Promise<void> {
  return invoke("watch_files", { root: root ?? null });
}

/** One debounced batch of paths that moved under the watched root. */
export function onFilesChanged(
  handle: (changed: FilesChanged) => void,
): Promise<UnlistenFn> {
  return listen<FilesChanged>("files-changed", ({ payload }) => handle(payload));
}

/** Every run's panel layout and tabs, kept in the app's own config. */
export function readPanels(): Promise<unknown> {
  return invoke("read_panels");
}

export function writePanels(panels: PanelStore): Promise<void> {
  return invoke("write_panels", { panels });
}
