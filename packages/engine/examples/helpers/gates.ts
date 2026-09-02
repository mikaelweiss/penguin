/** One gate: the command to run, and the path a change has to touch for it to run at all. */
export type Gate = { command: string; scope: string };

/** What one gate did: its exit code and the tail of what it printed. */
export type Ran = { command: string; code: number; output: string };

/** How much of a gate's output a report carries, so a chatty command cannot flood a prompt. */
const TAIL = 3000;

const SCOPED = /^\[([^\]]*)\]\s*(.*)$/;

/**
 * The gates a project lists, in file order. A blank line and a line opening with
 * `#` are not gates. `[path] command` is a gate that runs only for a change under path.
 */
export function parseGates(text: string): Gate[] {
  const gates: Gate[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const scoped = SCOPED.exec(line);
    if (scoped === null) {
      gates.push({ command: line, scope: "" });
      continue;
    }
    const command = (scoped[2] ?? "").trim();
    if (command === "") continue;
    gates.push({ command, scope: (scoped[1] ?? "").trim() });
  }
  return gates;
}

/** Whether file sits under dir, by whole path segment, so apps/desktop never claims apps/desktop-old. */
export function under(dir: string, file: string): boolean {
  const base = dir.replace(/^\.\//, "").replace(/\/+$/, "");
  const at = file.replace(/^\.\//, "");
  if (base === "") return true;
  return at === base || at.startsWith(`${base}/`);
}

/**
 * The gates a change runs: every unscoped one, plus each scoped one a changed file
 * sits under. Changed files nobody could name mean every gate runs.
 */
export function gatesFor(gates: Gate[], changed: string[] | undefined): Gate[] {
  if (changed === undefined) return gates;
  return gates.filter(
    (gate) => gate.scope === "" || changed.some((file) => under(gate.scope, file)),
  );
}

/** Keeps the end of what a gate printed, which is where a failure names itself. */
export function tail(text: string, limit: number = TAIL): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `… ${trimmed.slice(-limit)}`;
}

/** One line per gate, the command and its verdict, with a failure's output under it. */
export function reportOf(ran: Ran[]): string {
  if (ran.length === 0) return "no gates ran";
  return ran
    .map((gate) =>
      gate.code === 0 ? `${gate.command}: pass` : `${gate.command}: fail\n${gate.output}\n`,
    )
    .join("\n");
}
