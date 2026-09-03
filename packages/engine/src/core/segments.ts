/**
 * How a run file is read: a head line opens each segment, the lines one process wrote,
 * and a closing note ends it. Every reader of run.jsonl, the engine and its frontends,
 * cuts the file the same way.
 */

export type Entry = Record<string, unknown>;

export function isHead(entry: Entry): boolean {
  return entry["call"] === undefined && "run" in entry && "workflow" in entry && "params" in entry;
}

export function isClosing(entry: Entry): boolean {
  return (
    entry["call"] === undefined &&
    ("outcome" in entry || "threw" in entry || "paused" in entry || entry["stopped"] === true)
  );
}

/** The entries the run's latest process wrote, after the head that opened its segment. */
export function lastSegment(entries: Entry[]): Entry[] {
  const opened = entries.findLastIndex(isHead);
  return opened === -1 ? entries : entries.slice(opened + 1);
}
