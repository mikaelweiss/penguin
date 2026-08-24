import { invoke } from "@tauri-apps/api/core";

export type RunUpdate = {
  id: string;
  /** The run file's bytes past the offset that was asked for. */
  text: string;
  offset: number;
  alive: boolean;
};

export function readRuns(offsets: Record<string, number>): Promise<RunUpdate[]> {
  return invoke<RunUpdate[]>("read_runs", { offsets });
}
