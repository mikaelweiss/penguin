import { invoke } from "@tauri-apps/api/core";

export function readDirs(): Promise<string[]> {
  return invoke<string[]>("read_dirs");
}

export function writeDirs(dirs: string[]): Promise<void> {
  return invoke("write_dirs", { dirs });
}

/** A folder's git project root, the key the sidebar groups runs by. */
export function projectRoot(dir: string): Promise<string> {
  return invoke<string>("project_root", { dir });
}
