import { cut, plain } from "./text.ts";

const DETAIL = 44;

export type Status = {
  state: string;
  detail?: string;
  running?: number;
  diff: string;
  facts: Record<string, string | number | boolean>;
};

/** The one line on the last row of the screen: what the run is doing, and its live numbers. */
export function statusLine(status: Status): string {
  const parts: string[] = [];
  if (status.state !== "") {
    const detail = status.detail === undefined ? "" : brief(status.detail);
    parts.push(detail === "" ? status.state : `${status.state}: ${detail}`);
  }
  if (status.running !== undefined) parts.push(elapsed(status.running));
  if (status.diff !== "") parts.push(status.diff);
  for (const [name, value] of Object.entries(status.facts)) parts.push(`${name} ${value}`);
  return parts.join("  ");
}

/** A detail is a whole question at times. The line takes its first words. */
export function brief(detail: string): string {
  const first = detail.split("\n").find((line) => line.trim() !== "") ?? "";
  return cut(plain(first), DETAIL);
}

export function elapsed(millis: number): string {
  const seconds = Math.floor(millis / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m${seconds % 60}s`;
  return `${hours}h${minutes % 60}m`;
}
