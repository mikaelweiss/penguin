import { credentials } from "@mikaelweiss/penguin-engine/protocol";
import type { Attention } from "@mikaelweiss/penguin-viewer";

export type Ask = Extract<Attention, { kind: "credential" }>;

export type Fix = "retry" | "reset" | "edit" | "stop";

/** The four ways out when a provider refuses the values penguin holds. */
export function fixes(name: string): { label: string; note?: string; fix: Fix }[] {
  return [
    { label: "try again", note: "use the values penguin has", fix: "retry" },
    { label: "enter it again", note: "type each value again", fix: "reset" },
    { label: "edit the file", note: `open ${credentials.where(name)}`, fix: "edit" },
    { label: "stop the run", fix: "stop" },
  ];
}

export function why(asked: Ask): string[] {
  const lines = asked.reason === undefined ? [] : [asked.reason];
  return lines;
}

export function notes(asked: Ask): string[] {
  const lines: string[] = [];
  if (asked.url !== undefined) lines.push(`make one at ${asked.url}`);
  if (asked.hint !== undefined) lines.push(asked.hint);
  const vars = asked.fields.map((field) => field.env).filter((name) => name !== undefined);
  if (vars.length > 0) lines.push(`or set ${vars.join(", ")} in your environment`);
  lines.push(`penguin keeps it in ${credentials.where(asked.name)}, readable by you alone`);
  return lines;
}
