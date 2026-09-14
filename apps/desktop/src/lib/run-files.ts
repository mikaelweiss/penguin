import { invoke } from "@tauri-apps/api/core";

export type RunUpdate = {
  id: string;
  /** Whole lines past the offset that was asked for. A big file arrives over several reads. */
  text: string;
  /** Where the next read starts: after the last line in `text`. */
  offset: number;
  alive: boolean;
  /** Whole lines past `offset` were left behind when the read's budget ran out. */
  more: boolean;
};

export function readRuns(offsets: Record<string, number>): Promise<RunUpdate[]> {
  return invoke<RunUpdate[]>("read_runs", { offsets });
}

/**
 * Ends each run and every run it spawned, and settles once their processes are gone. A run is asked
 * first and killed if it will not go, so what comes back saying stopped is stopped. Naming a run
 * that already ended is no trouble: the ones inside it may still be going.
 */
export function stopRuns(ids: string[]): Promise<void> {
  return invoke("stop_runs", { ids });
}

/** SIGINT to each run and the runs it spawned. Each writes its own paused note as it goes. */
export function pauseRuns(ids: string[]): Promise<void> {
  return invoke("pause_runs", { ids });
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
