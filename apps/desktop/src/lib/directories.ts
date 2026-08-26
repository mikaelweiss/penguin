import { invoke } from "@tauri-apps/api/core";

export function readDirs(): Promise<string[]> {
  return invoke<string[]>("read_dirs");
}

export function writeDirs(dirs: string[]): Promise<void> {
  return invoke("write_dirs", { dirs });
}

/** Each hidden project root against the instant it was hidden. */
export type Hidden = Record<string, string>;

export function readHidden(): Promise<Hidden> {
  return invoke<Hidden>("read_hidden");
}

export function writeHidden(hidden: Hidden): Promise<void> {
  return invoke("write_hidden", { hidden });
}

/** A folder's git project root, the key the sidebar groups runs by. */
export function projectRoot(dir: string): Promise<string> {
  return invoke<string>("project_root", { dir });
}
