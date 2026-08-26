import type {
  ActionItem,
  ActionKind,
  OutputLine,
  Run,
  RunInput,
  RunState,
  TranscriptItem,
  TurnMark,
} from "@/lib/runs";

export type TranscriptRow =
  | { kind: "input"; key: string; input: RunInput[] }
  | { kind: "line"; key: string; line: OutputLine }
  | { kind: "actions"; key: string; actions: ActionItem[]; summary: string; failures: number }
  | { kind: "turn"; key: string; label: string }
  | { kind: "live"; key: string; state: RunState }
  | { kind: "closing"; key: string; text: string };

const CLOSING: Partial<Record<Run["status"], string>> = {
  done: "run finished",
  failed: "run failed",
  stopped: "run stopped",
  crashed: "run crashed",
};

const NOUNS: Record<ActionKind, [one: string, many: string]> = {
  run: ["command", "commands"],
  read: ["file", "files"],
  edit: ["file", "files"],
  search: ["search", "searches"],
  fetch: ["page", "pages"],
  agent: ["agent", "agents"],
};

const VERBS: Record<ActionKind, string> = {
  run: "Ran",
  read: "Read",
  edit: "Changed",
  search: "Searched",
  fetch: "Fetched",
  agent: "Ran",
};

/** Repeated edits to one file read as one change, so the count matches what the run did. */
function reach(kind: ActionKind, actions: ActionItem[]): number {
  if (kind !== "edit" && kind !== "read") return actions.length;
  const targets = new Set<string>();
  let untargeted = 0;
  for (const action of actions) {
    if (action.target === undefined) untargeted += 1;
    else targets.add(action.target);
  }
  return targets.size + untargeted;
}

function join(clauses: string[]): string {
  const [first, ...rest] = clauses;
  if (first === undefined) return "";
  const lowered = [first, ...rest.map((clause) => clause[0]!.toLowerCase() + clause.slice(1))];
  if (lowered.length === 1) return lowered[0]!;
  if (lowered.length === 2) return lowered.join(" and ");
  return `${lowered.slice(0, -1).join(", ")}, and ${lowered.at(-1)}`;
}

/** What a folded group of tool calls did, as a sentence rather than a bare count. */
export function summarizeActions(actions: ActionItem[]): string {
  const byKind = new Map<ActionKind | "other", ActionItem[]>();
  for (const action of actions) {
    const key = action.kind ?? "other";
    byKind.set(key, [...(byKind.get(key) ?? []), action]);
  }

  const clauses = [...byKind].map(([kind, group]) => {
    if (kind === "other") {
      return `Used ${group.length} ${group.length === 1 ? "tool" : "tools"}`;
    }
    const count = reach(kind, group);
    const [one, many] = NOUNS[kind];
    return `${VERBS[kind]} ${count} ${count === 1 ? one : many}`;
  });
  return join(clauses);
}

/** The step, and who took it. One agent working alone needs no number to tell it apart. */
function labelTurn(turn: TurnMark, agents: number): string {
  const who = agents > 1 ? `agent ${turn.agent}` : undefined;
  if (turn.skill === undefined) return who ?? "agent";
  return who === undefined ? turn.skill : `${turn.skill} · ${who}`;
}

function at(item: TranscriptItem): string {
  return item.type === "line" ? item.line.at : item.at;
}

/** Both sides carry a timestamp, so a sent message lands where it was sent, not at the end. */
function ordered(run: Run, sent: OutputLine[]): TranscriptItem[] {
  if (sent.length === 0) return run.output;
  const mine = sent.map((line): TranscriptItem => ({ type: "line", line }));
  return [...run.output, ...mine].sort((a, b) => at(a).localeCompare(at(b)));
}

export function toRows(run: Run, sent: OutputLine[], live: RunState | undefined): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  if (run.input.length > 0) rows.push({ kind: "input", key: "input", input: run.input });

  const agents = new Set(run.output.flatMap((item) => (item.type === "turn" ? [item.agent] : [])));

  for (const item of ordered(run, sent)) {
    if (item.type === "turn") {
      rows.push({ kind: "turn", key: `turn:${item.id}`, label: labelTurn(item, agents.size) });
      continue;
    }
    if (item.type === "action") {
      const tail = rows.at(-1);
      if (tail?.kind === "actions") {
        tail.actions.push(item);
        continue;
      }
      rows.push({
        kind: "actions",
        key: `actions:${item.id}`,
        actions: [item],
        summary: "",
        failures: 0,
      });
      continue;
    }
    const { line } = item;
    rows.push({ kind: "line", key: `line:${line.kind}:${line.id}`, line });
  }

  for (const row of rows) {
    if (row.kind !== "actions") continue;
    row.summary = summarizeActions(row.actions);
    row.failures = row.actions.filter((action) => action.status === "failed").length;
  }

  const closing = CLOSING[run.status];
  if (closing !== undefined) rows.push({ kind: "closing", key: "closing", text: closing });

  const reason = run.problem;
  if (reason !== undefined) {
    rows.push({
      kind: "line",
      key: "line:problem",
      line: { id: "problem", kind: "problem", text: reason, at: "" },
    });
  }

  if (live !== undefined) rows.push({ kind: "live", key: "live", state: live });
  return rows;
}

/** Where a turn begins. The scroller parks these near the top instead of chasing the tail. */
export function startsTurn(row: TranscriptRow): boolean {
  if (row.kind === "input" || row.kind === "turn") return true;
  return row.kind === "line" && row.line.kind === "message";
}

function sameActions(a: ActionItem[], b: ActionItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((action, index) => {
    const other = b[index]!;
    return (
      action.id === other.id &&
      action.name === other.name &&
      action.kind === other.kind &&
      action.status === other.status &&
      action.target === other.target &&
      action.output === other.output &&
      action.doneAt === other.doneAt
    );
  });
}

/** Shallow per-kind comparison. Deep equality would cost more than the render it saves. */
function same(a: TranscriptRow, b: TranscriptRow): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  switch (a.kind) {
    case "input":
      return a.input === (b as typeof a).input;
    case "line": {
      const other = (b as typeof a).line;
      return (
        a.line.text === other.text &&
        a.line.at === other.at &&
        a.line.attachments === other.attachments
      );
    }
    case "actions": {
      const other = b as typeof a;
      return (
        a.summary === other.summary &&
        a.failures === other.failures &&
        sameActions(a.actions, other.actions)
      );
    }
    case "turn":
      return a.label === (b as typeof a).label;
    case "live": {
      const other = (b as typeof a).state;
      return a.state.text === other.text && a.state.at === other.at && a.state.idle === other.idle;
    }
    case "closing":
      return a.text === (b as typeof a).text;
  }
}

/**
 * The run tree is rebuilt from scratch every poll, so every row is a fresh object even when
 * nothing about it moved. Handing the unchanged ones back their old identity is what lets the
 * rows memo, and what keeps the markdown from re-parsing four times a second.
 */
export function reuseRows(
  previous: TranscriptRow[] | undefined,
  rows: TranscriptRow[],
): TranscriptRow[] {
  if (previous === undefined || previous.length === 0) return rows;
  const byKey = new Map(previous.map((row) => [row.key, row]));

  let moved = previous.length !== rows.length;
  const next = rows.map((row, index) => {
    const known = byKey.get(row.key);
    const kept = known !== undefined && same(known, row) ? known : row;
    if (!moved && previous[index] !== kept) moved = true;
    return kept;
  });

  return moved ? next : previous;
}
