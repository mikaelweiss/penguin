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

/** SIGINT to each run's process group. The run writes its own paused note as it goes. */
export function pauseRuns(ids: string[]): Promise<void> {
  return invoke("pause_runs", { ids });
}

/** Ends each parked run where it stands, with a stopped note on its file. */
export function closeRuns(ids: string[]): Promise<void> {
  return invoke("close_runs", { ids });
}

/**
 * Starts the run again in its own folder, where it takes up what it had left. A timer passes
 * `onlyPaused`, so it never undoes a stop or restarts a run that went on without it.
 */
export function resumeRun(id: string, onlyPaused = false): Promise<void> {
  return invoke("resume_run", { id, onlyPaused });
}

/** Stops each run and deletes its folder. */
export function forgetRuns(ids: string[]): Promise<void> {
  return invoke("forget_runs", { ids });
}

/** Appends a `{"name": ...}` note to the run's file. The newest one is the run's name. */
export function renameRun(id: string, name: string): Promise<void> {
  return invoke("rename_run", { id, name });
}

/** What a run wrote to stderr. A run that died before its file could say why left it only there. */
export function readRunLog(id: string): Promise<string> {
  return invoke<string>("read_run_log", { id });
}
