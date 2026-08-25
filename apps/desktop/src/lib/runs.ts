import type { Attachment } from "@/lib/attachments";

export type RunStatus = "running" | "done" | "failed" | "stopped" | "crashed";

export type OutputLine = {
  kind: "show" | "ask" | "answer" | "message" | "problem";
  text: string;
  at: string;
  /** What a sent message carried. The run file holds only the paths. */
  attachments?: Attachment[];
};

/** What the run does right now, from its last view.status call. */
export type RunState = {
  text: string;
  at: string;
  /** The run waits on an outside event, not on its own work. */
  idle: boolean;
};

export type ActionKind = "run" | "read" | "edit" | "search" | "fetch" | "agent";

/** One tool call the run made, updated in place as its view.act calls arrive. */
export type ActionItem = {
  type: "action";
  id: string;
  name: string;
  kind?: ActionKind;
  status: "running" | "done" | "failed";
  target?: string;
  output?: string;
  at: string;
};

export type TranscriptItem = { type: "line"; line: OutputLine } | ActionItem;

export type Ask = {
  prompt: string;
  /** The JSON Schema the workflow asked with, when it named one. */
  schema: Record<string, unknown> | undefined;
  /** Why the engine refused the last answer to this question. */
  problem: string | undefined;
};

export type Run = {
  id: string;
  name: string;
  status: RunStatus;
  dir: string;
  ask?: Ask;
  /** Why the run ended badly, when its own file says. */
  problem?: string;
  /** The run is waiting on view.listen, so it can take a message. */
  listening: boolean;
  state?: RunState;
  output: TranscriptItem[];
  children: Run[];
};

export type Project = {
  id: string;
  name: string;
  dir: string;
  runs: Run[];
};

export type RunNode = {
  run: Run;
  project: Project;
  depth: number;
  ancestors: Run[];
};

export function isLive(run: Run): boolean {
  return run.status === "running" || run.children.some(isLive);
}

export function isIdle(run: Run): boolean {
  return run.status === "running" && run.ask === undefined && run.state?.idle === true;
}

/** A run and every run inside it, outermost first, the order stopping sends them in. */
export function subtree(run: Run): string[] {
  return [run.id, ...run.children.flatMap(subtree)];
}

/** The first run inside this one waiting on an answer, and the ids to expand to reach it. */
export function findBlocked(run: Run): { expand: string[]; blocked: Run } | undefined {
  for (const child of run.children) {
    if (child.ask) return { expand: [run.id], blocked: child };
    const deeper = findBlocked(child);
    if (deeper) return { expand: [run.id, ...deeper.expand], blocked: deeper.blocked };
  }
  return undefined;
}

type VisibleOptions = {
  collapsed: ReadonlySet<string>;
  showFinished: boolean;
};

/** The rows the sidebar draws for one project, deepest first within each branch. */
export function visibleRuns(project: Project, options: VisibleOptions): RunNode[] {
  const rows: RunNode[] = [];

  const walk = (runs: Run[], depth: number, ancestors: Run[]) => {
    for (const run of runs) {
      if (!options.showFinished && !isLive(run)) continue;
      rows.push({ run, project, depth, ancestors });
      if (options.collapsed.has(run.id)) continue;
      walk(run.children, depth + 1, [...ancestors, run]);
    }
  };

  walk(project.runs, 0, []);
  return rows;
}

export function findRun(projects: Project[], id: string | undefined): RunNode | undefined {
  if (id === undefined) return undefined;

  for (const project of projects) {
    const rows = visibleRuns(project, { collapsed: new Set(), showFinished: true });
    const found = rows.find((row) => row.run.id === id);
    if (found) return found;
  }
  return undefined;
}

export type Entry = Record<string, unknown>;

export type RunFile = {
  id: string;
  entries: Entry[];
  alive: boolean;
};

export function parseEntries(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      // a half written line; the next read sees it whole
    }
  }
  return entries;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function argsOf(entry: Entry): unknown[] {
  return Array.isArray(entry["args"]) ? (entry["args"] as unknown[]) : [];
}

function display(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function workflowName(file: string): string {
  return baseName(file).replace(/\.[^.]+$/, "");
}

type Closing = {
  status: RunStatus;
  /** What the run threw. A crashed run left nothing here, only a start log. */
  problem?: string;
};

function closingOf(notes: Entry[], alive: boolean): Closing {
  const closing = notes.findLast(
    (note) => "outcome" in note || "threw" in note || note["stopped"] === true,
  );
  if (closing === undefined) return { status: alive ? "running" : "crashed" };
  if (closing["stopped"] === true) return { status: "stopped" };
  if ("threw" in closing) return { status: "failed", problem: display(closing["threw"]) };
  return { status: "done" };
}

/** The question the run is stuck on, when one is still unanswered. */
function waitingAsk(entries: Entry[]): Entry | undefined {
  const asks = entries.filter((entry) => entry["call"] === "view.ask");
  const settled = new Set(
    asks.filter((entry) => entry["pending"] !== true).map((entry) => entry["id"]),
  );
  return asks.find((entry) => entry["pending"] === true && !settled.has(entry["id"]));
}

function askOf(entries: Entry[], waiting: Entry): Ask {
  const args = argsOf(waiting);
  const schema = args[1];
  return {
    prompt: display(args[0]),
    schema:
      schema !== null && typeof schema === "object"
        ? (schema as Record<string, unknown>)
        : undefined,
    problem: problemOf(entries, waiting),
  };
}

/** The engine's complaint about the last answer, when it came after this question. */
function problemOf(entries: Entry[], waiting: Entry): string | undefined {
  const refused = entries.slice(entries.indexOf(waiting)).findLast((entry) => "rejected" in entry);
  return refused === undefined ? undefined : text(refused["problem"]);
}

const KINDS: ReadonlySet<string> = new Set(["run", "read", "edit", "search", "fetch", "agent"]);

function kindOf(value: unknown): ActionKind | undefined {
  return typeof value === "string" && KINDS.has(value) ? (value as ActionKind) : undefined;
}

function statusOf(value: unknown): ActionItem["status"] {
  return value === "done" || value === "failed" ? value : "running";
}

function actionOf(entry: Entry, actions: Map<string, ActionItem>): ActionItem | undefined {
  const sent = argsOf(entry)[0];
  if (sent === null || typeof sent !== "object") return undefined;
  const call = sent as Record<string, unknown>;
  const id = text(call["id"]);
  const name = text(call["name"]);
  if (id === undefined || name === undefined) return undefined;

  const kind = kindOf(call["kind"]);
  const target = text(call["target"]);
  const output = text(call["output"]);
  const known = actions.get(id);
  if (known !== undefined) {
    known.name = name;
    known.status = statusOf(call["status"]);
    if (kind !== undefined) known.kind = kind;
    if (target !== undefined) known.target = target;
    if (output !== undefined) known.output = output;
    return undefined;
  }
  const action: ActionItem = {
    type: "action",
    id,
    name,
    status: statusOf(call["status"]),
    at: text(entry["at"]) ?? "",
    ...(kind === undefined ? {} : { kind }),
    ...(target === undefined ? {} : { target }),
    ...(output === undefined ? {} : { output }),
  };
  actions.set(id, action);
  return action;
}

function outputOf(entries: Entry[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const actions = new Map<string, ActionItem>();
  const line = (kind: OutputLine["kind"], value: string, at: string): void => {
    items.push({ type: "line", line: { kind, text: value, at } });
  };
  for (const entry of entries) {
    const args = argsOf(entry);
    const at = text(entry["at"]) ?? "";
    if (entry["call"] === "view.show" && entry["pending"] === true && args[1] === undefined) {
      line("show", display(args[0]), at);
    } else if (entry["call"] === "view.act" && entry["pending"] === true) {
      const action = actionOf(entry, actions);
      if (action !== undefined) items.push(action);
    } else if (entry["call"] === "view.ask" && entry["pending"] === true) {
      line("ask", display(args[0]), at);
    } else if (entry["call"] === "view.ask" && "outcome" in entry) {
      line("answer", display(entry["outcome"]), at);
    }
  }
  return items;
}

function stateOf(entries: Entry[]): RunState | undefined {
  const latest = entries.findLast(
    (entry) => entry["call"] === "view.status" && entry["pending"] === true,
  );
  if (latest === undefined) return undefined;
  const args = argsOf(latest);
  const options = args[1] as { idle?: boolean } | undefined;
  return {
    text: display(args[0]),
    at: text(latest["at"]) ?? "",
    idle: options?.idle === true,
  };
}

type Placed = {
  run: Run;
  parent: string | undefined;
  root: string;
  at: string;
};

function place(file: RunFile): Placed | undefined {
  const head = file.entries.find((entry) => "workflow" in entry && "params" in entry);
  const workflow = text(head?.["workflow"]);
  const cwd = text(head?.["cwd"]);
  const root = text(head?.["root"]);
  if (head === undefined || workflow === undefined || cwd === undefined || root === undefined) {
    return undefined;
  }

  const notes = file.entries.filter((entry) => entry["call"] === undefined);
  const moved = notes.findLast((note) => text(note["dir"]) !== undefined);
  const renamed = notes.findLast((note) => text(note["name"]) !== undefined);
  const closing = closingOf(notes, file.alive);
  const status = closing.status;
  const heard = notes.findLast((note) => typeof note["listening"] === "boolean");
  // A run that is no longer running cannot take an answer or a message, whatever its notes say.
  const waiting = status === "running" ? waitingAsk(file.entries) : undefined;
  const ask = waiting === undefined ? undefined : askOf(file.entries, waiting);
  const listening = status === "running" && heard?.["listening"] === true;
  const state = status === "running" ? stateOf(file.entries) : undefined;

  return {
    run: {
      id: file.id,
      name: text(renamed?.["name"]) ?? workflowName(workflow),
      status,
      dir: text(moved?.["dir"]) ?? cwd,
      ...(ask === undefined ? {} : { ask }),
      ...(closing.problem === undefined ? {} : { problem: closing.problem }),
      listening,
      ...(state === undefined ? {} : { state }),
      output: outputOf(file.entries),
      children: [],
    },
    parent: text(head["parent"]),
    root,
    at: text(head["at"]) ?? "",
  };
}

/**
 * The run files as a tree of projects, grouped by each run's git root and linked by parent id.
 * The directories the user added come through even before they hold a run.
 */
export function toProjects(files: RunFile[], dirs: string[]): Project[] {
  const placed = files
    .map(place)
    .filter((entry): entry is Placed => entry !== undefined)
    .sort((a, b) => a.at.localeCompare(b.at));
  const byId = new Map(placed.map((entry) => [entry.run.id, entry]));
  const projects = new Map<string, Project>();
  for (const dir of dirs) {
    projects.set(dir, { id: dir, name: baseName(dir), dir, runs: [] });
  }

  for (const entry of placed) {
    const parent = entry.parent === undefined ? undefined : byId.get(entry.parent);
    if (parent !== undefined && parent.run.id !== entry.run.id) {
      parent.run.children.push(entry.run);
      continue;
    }
    let project = projects.get(entry.root);
    if (project === undefined) {
      project = { id: entry.root, name: baseName(entry.root), dir: entry.root, runs: [] };
      projects.set(entry.root, project);
    }
    project.runs.push(entry.run);
  }

  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name));
}
