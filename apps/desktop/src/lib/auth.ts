import { invoke } from "@tauri-apps/api/core";

/** Saves one named secret to the keychain and bumps its epoch file, resuming every paused run. */
export function storeAuthSecret(name: string, value: Record<string, string>): Promise<void> {
  return invoke("store_auth_secret", { name, value });
}
