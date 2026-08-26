import type { Attachment } from "@/lib/attachments";
import type { Hidden } from "@/lib/directories";

export type RunStatus = "running" | "done" | "failed" | "stopped" | "crashed";

export type OutputLine = {
  /** The call that wrote the line. A question and its answer share one, so both key on the kind too. */
  id: string;
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
  /** When the call settled. The engine's own elapsedMs times its bookkeeping, not the tool. */
  doneAt?: string;
};

/** Where the run handed work to an agent. The step boundary the story otherwise runs straight through. */
export type TurnMark = {
  type: "turn";
  id: string;
  /** The skill the turn runs, when the workflow named one instead of a bare prompt. */
  skill?: string;
  /** Which agent took it, in the order the run first gave each one work. */
  agent: number;
  at: string;
};

export type TranscriptItem = { type: "line"; line: OutputLine } | ActionItem | TurnMark;

export type Ask = {
  prompt: string;
  /** The JSON Schema the workflow asked with, when it named one. */
  schema: Record<string, unknown> | undefined;
  /** Why the engine refused the last answer to this question. */
  problem: string | undefined;
};

/** The credentials a run's adapter waits on, from its unresolved auth note. */
export type Auth = {
  role: string;
  /** Why the adapter paused: missing credentials, or the service's refusal. */
  reason: string;
  at: string;
};

/** One plain-text value the run was started with. */
export type RunInput = { name: string; text: string };

export type Run = {
  id: string;
  name: string;
  status: RunStatus;
  dir: string;
  ask?: Ask;
  auth?: Auth;
  /** Why the run ended badly, when its own file says. */
  problem?: string;
  /** The run is waiting on view.listen, so it can take a message. */
  listening: boolean;
  state?: RunState;
  input: RunInput[];
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
  return run.status === "running" && !needsYou(run) && run.state?.idle === true;
}

/** A run and every run inside it, outermost first, the order stopping sends them in. */
export function subtree(run: Run): string[] {
  return [run.id, ...run.children.flatMap(subtree)];
}

/** The first run inside this one waiting on an answer, and the ids to expand to reach it. */
/** The run cannot move until a person answers or authenticates. */
export function needsYou(run: Run): boolean {
  return run.ask !== undefined || run.auth !== undefined;
}

/** What the run waits on, changing whenever the call on the person is a new one. */
export function blockedOn(run: Run): string | undefined {
  if (run.auth !== undefined) return `auth:${run.auth.role}:${run.auth.at}`;
  if (run.ask !== undefined) return `ask:${run.ask.prompt}:${run.ask.problem ?? ""}`;
  return undefined;
}

function blockedBy(projects: Project[]): Map<string, string> {
  const signatures = new Map<string, string>();
  for (const project of projects) {
    for (const row of visibleRuns(project, { collapsed: new Set(), showFinished: true })) {
      const signature = blockedOn(row.run);
      if (signature !== undefined) signatures.set(row.run.id, signature);
    }
  }
  return signatures;
}

/** The runs that started waiting on a person this tick, a re-ask counting as a fresh one. */
export function newlyBlocked(before: Project[], after: Project[]): Run[] {
  const was = blockedBy(before);
  const started: Run[] = [];
  for (const project of after) {
    for (const row of visibleRuns(project, { collapsed: new Set(), showFinished: true })) {
      const signature = blockedOn(row.run);
      if (signature !== undefined && was.get(row.run.id) !== signature) started.push(row.run);
    }
  }
  return started;
}

const NOTICE_LIMIT = 200;

function oneLine(said: string): string {
  const flat = said.replace(/\s+/g, " ").trim();
  return flat.length <= NOTICE_LIMIT ? flat : `${flat.slice(0, NOTICE_LIMIT - 1).trimEnd()}…`;
}

/** What the desktop notification for a waiting run says. */
export function needsYouNotice(run: Run): { title: string; body: string } | undefined {
  const said =
    run.auth !== undefined
      ? `Waiting on ${run.auth.role} credentials`
      : (run.ask?.problem ?? run.ask?.prompt);
  if (said === undefined) return undefined;
  return { title: `${run.name} needs you`, body: oneLine(said) };
}

export function findBlocked(run: Run): { expand: string[]; blocked: Run } | undefined {
  for (const child of run.children) {
    if (needsYou(child)) return { expand: [run.id], blocked: child };
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

/** The parent the view sits on, and the children it already had when the view arrived. */
export type Follow = { parent: string; known: ReadonlySet<string> };

export type ViewMove = { select: string; follow: Follow | undefined };

/** Where the output area belongs after this tick, or undefined to leave it where it is. */
export function nextView(
  before: Project[],
  after: Project[],
  selectedId: string | undefined,
  follow: Follow | undefined,
): ViewMove | undefined {
  const node = findRun(after, selectedId);
  if (node === undefined) return undefined;

  if (follow !== undefined && follow.parent === selectedId) {
    const seen = follow.known;
    const born = node.run.children.find((child) => !seen.has(child.id));
    if (born !== undefined) return { select: born.id, follow: undefined };
  }

  if (findRun(before, selectedId)?.run.status !== "running") return undefined;
  if (node.run.status !== "done") return undefined;
  const parent = node.ancestors.at(-1);
  if (parent === undefined) return undefined;

  // The children as of the tick the watched run still ran, so a same-tick spawn counts as new.
  const known = findRun(before, parent.id)?.run.children ?? parent.children;
  return {
    select: parent.id,
    follow: { parent: parent.id, known: new Set(known.map((child) => child.id)) },
  };
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

/** The credentials request the run is stuck on, when the last auth note is unresolved. */
function authOf(notes: Entry[]): Auth | undefined {
  const last = notes.findLast((note) => note["auth"] !== undefined);
  const auth = last?.["auth"];
  if (auth === null || typeof auth !== "object") return undefined;
  const asked = auth as Record<string, unknown>;
  const role = text(asked["role"]);
  if (asked["resolved"] === true || role === undefined) return undefined;
  return { role, reason: text(asked["reason"]) ?? "", at: text(last?.["at"]) ?? "" };
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
  const status = statusOf(call["status"]);
  const at = text(entry["at"]) ?? "";
  const known = actions.get(id);
  if (known !== undefined) {
    known.name = name;
    known.status = status;
    if (kind !== undefined) known.kind = kind;
    if (target !== undefined) known.target = target;
    if (output !== undefined) known.output = output;
    if (status !== "running") known.doneAt = at;
    return undefined;
  }
  const action: ActionItem = {
    type: "action",
    id,
    name,
    status,
    at,
    ...(kind === undefined ? {} : { kind }),
    ...(target === undefined ? {} : { target }),
    ...(output === undefined ? {} : { output }),
    ...(status === "running" ? {} : { doneAt: at }),
  };
  actions.set(id, action);
  return action;
}

function agentOf(session: string, agents: Map<string, number>): number {
  const known = agents.get(session);
  if (known !== undefined) return known;
  const ordinal = agents.size + 1;
  agents.set(session, ordinal);
  return ordinal;
}

function turnOf(entry: Entry, agents: Map<string, number>, id: string): TurnMark | undefined {
  const args = argsOf(entry);
  const session = text(args[0]);
  if (session === undefined) return undefined;
  const ask = args[1];
  const named = ask === null || typeof ask !== "object" ? undefined : (ask as Entry)["skill"];
  const skill = text(named);
  return {
    type: "turn",
    id,
    agent: agentOf(session, agents),
    ...(skill === undefined ? {} : { skill }),
    at: text(entry["at"]) ?? "",
  };
}

function outputOf(entries: Entry[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const actions = new Map<string, ActionItem>();
  const agents = new Map<string, number>();
  let turns = 0;
  for (const entry of entries) {
    const args = argsOf(entry);
    const at = text(entry["at"]) ?? "";
    const id = text(entry["id"]) ?? at;
    const line = (kind: OutputLine["kind"], value: string): void => {
      items.push({ type: "line", line: { id, kind, text: value, at } });
    };
    if (entry["call"] === "view.show" && entry["pending"] === true && args[1] === undefined) {
      line("show", display(args[0]));
    } else if (entry["call"] === "view.act" && entry["pending"] === true) {
      const action = actionOf(entry, actions);
      if (action !== undefined) items.push(action);
    } else if (entry["call"] === "view.ask" && entry["pending"] === true) {
      line("ask", display(args[0]));
    } else if (entry["call"] === "view.ask" && "outcome" in entry) {
      line("answer", display(entry["outcome"]));
    } else if (entry["call"] === "agent.turn" && entry["handle"] === true) {
      const mark = turnOf(entry, agents, `t${++turns}`);
      if (mark !== undefined) items.push(mark);
    }
  }
  return items;
}

/** The plain-text values the run started with, in the order its head entry recorded them. */
function inputOf(head: Entry): RunInput[] {
  const params = head["params"];
  if (params === null || typeof params !== "object" || Array.isArray(params)) return [];
  return Object.entries(params as Record<string, unknown>).flatMap(([name, value]) => {
    const written = text(value);
    return written === undefined || written.trim() === "" ? [] : [{ name, text: written }];
  });
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
  const auth = status === "running" ? authOf(notes) : undefined;
  const listening = status === "running" && heard?.["listening"] === true;
  const state = status === "running" ? stateOf(file.entries) : undefined;

  return {
    run: {
      id: file.id,
      name: text(renamed?.["name"]) ?? workflowName(workflow),
      status,
      dir: text(moved?.["dir"]) ?? cwd,
      ...(ask === undefined ? {} : { ask }),
      ...(auth === undefined ? {} : { auth }),
      ...(closing.problem === undefined ? {} : { problem: closing.problem }),
      listening,
      ...(state === undefined ? {} : { state }),
      input: inputOf(head),
      output: outputOf(file.entries),
      children: [],
    },
    parent: text(head["parent"]),
    root,
    at: text(head["at"]) ?? "",
  };
}

/** A hidden root keeps out the runs it already held, so only a newer one brings the project back. */
function shows(entry: Placed, hidden: Hidden): boolean {
  const at = hidden[entry.root];
  return at === undefined || entry.at > at;
}

/**
 * The run files as a tree of projects, grouped by each run's git root and linked by parent id.
 * The directories the user added come through even before they hold a run.
 */
export function toProjects(files: RunFile[], dirs: string[], hidden: Hidden = {}): Project[] {
  const placed = files
    .map(place)
    .filter((entry): entry is Placed => entry !== undefined && shows(entry, hidden))
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
