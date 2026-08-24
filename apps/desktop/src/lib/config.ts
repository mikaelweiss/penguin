import { invoke } from "@tauri-apps/api/core";

/** ~/.penguin/config, the settings the engine and the app share. */
export function readConfig(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("read_config");
}

/** Writes one setting, keeping every other line. An empty value drops the setting. */
export function writeConfig(key: string, value: string): Promise<void> {
  return invoke("write_config", { key, value });
}
