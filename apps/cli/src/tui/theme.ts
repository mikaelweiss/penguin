import type { NodeState } from "@mikaelweiss/penguin-viewer";

export const ink = {
  text: "#d0d0d0",
  dim: "#7a7a7a",
  faint: "#5a5a5a",
  accent: "#5fafd7",
  warn: "#d7af5f",
  bad: "#d75f5f",
  good: "#87af5f",
  cursor: "#1c1c1c",
  cursorBack: "#d0d0d0",
  border: "#3a3a3a",
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(frame: number): string {
  return SPINNER[frame % SPINNER.length] ?? "⠋";
}

/** One character for a node's state, the same alphabet everywhere penguin draws. */
export function glyph(state: NodeState, frame: number): string {
  if (state === "running") return spinner(frame);
  if (state === "blocked") return "!";
  if (state === "idle") return "~";
  if (state === "done") return "✓";
  if (state === "failed") return "✗";
  return "·";
}

export function stateColor(state: NodeState | string): string {
  if (state === "running") return ink.accent;
  if (state === "blocked") return ink.warn;
  if (state === "idle") return ink.dim;
  if (state === "done") return ink.good;
  if (state === "failed" || state === "error" || state === "stopped") return ink.bad;
  return ink.faint;
}
