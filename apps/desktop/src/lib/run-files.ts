import { invoke } from "@tauri-apps/api/core";

export type RunUpdate = {
  id: string;
  /** Whole lines past the offset that was asked for. A big file arrives over several reads. */
  text: string;
  /** Where the next read starts: after the last line in `text`. */
  offset: number;
  alive: boolean;
};

export function readRuns(offsets: Record<string, number>): Promise<RunUpdate[]> {
  return invoke<RunUpdate[]>("read_runs", { offsets });
}

/** SIGTERM to each run's process group. The run writes its own stopped note as it goes. */
export function stopRuns(ids: string[]): Promise<void> {
  return invoke("stop_runs", { ids });
}

/** Stops each run and deletes its folder. */
export function forgetRuns(ids: string[]): Promise<void> {
  return invoke("forget_runs", { ids });
}

/** Appends a `{"name": ...}` note to the run's file. The newest one is the run's name. */
export function renameRun(id: string, name: string): Promise<void> {
  return invoke("rename_run", { id, name });
}

/** What a run wrote to stderr. A crashed run left its reason only there. */
export function readRunLog(id: string): Promise<string> {
  return invoke<string>("read_run_log", { id });
}
