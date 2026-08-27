import type { OpenIn } from "@/hooks/use-browser";

/** Where a run's urls open: the panel, or the machine's own browser. */
export const OPEN_IN = "browser-open-in";

/** Whether a url a run opens also shows the panel. */
export const AUTO_SHOW = "browser-auto";

export function openIn(values: Record<string, string>): OpenIn {
  return values[OPEN_IN] === "system" ? "system" : "app";
}

/** On unless it was turned off, so a config with no line for it behaves the way it always did. */
export function autoShows(values: Record<string, string>): boolean {
  return values[AUTO_SHOW] !== "off";
}
