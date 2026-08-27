import { invoke } from "@tauri-apps/api/core";

/** One local port that answered with a web page. */
export type LocalServer = {
  port: number;
  url: string;
  /** The command holding the port, when the scan named one. */
  process: string | null;
};

export function localServers(): Promise<LocalServer[]> {
  return invoke<LocalServer[]>("local_servers");
}
