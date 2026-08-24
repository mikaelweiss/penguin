export type RunStatus = "running" | "done" | "failed" | "stopped" | "crashed";

export type OutputLine = {
  kind: "show" | "tool" | "ask" | "answer";
  text: string;
};

export type Ask = {
  prompt: string;
  /** The JSON Schema the workflow asked with, when it named one. */
  schema: Record<string, unknown> | undefined;
};

export type Run = {
  id: string;
  name: string;
  status: RunStatus;
  dir: string;
  ask?: Ask;
  output: OutputLine[];
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

function statusOf(notes: Entry[], alive: boolean): RunStatus {
  const closing = notes.findLast(
    (note) => "outcome" in note || "threw" in note || note["stopped"] === true,
  );
  if (closing === undefined) return alive ? "running" : "crashed";
  if (closing["stopped"] === true) return "stopped";
  if ("threw" in closing) return "failed";
  return "done";
}

function askOf(entries: Entry[]): Ask | undefined {
  const asks = entries.filter((entry) => entry["call"] === "view.ask");
  const settled = new Set(
    asks.filter((entry) => entry["pending"] !== true).map((entry) => entry["id"]),
  );
  const waiting = asks.find(
    (entry) => entry["pending"] === true && !settled.has(entry["id"]),
  );
  if (waiting === undefined) return undefined;
  const args = argsOf(waiting);
  const schema = args[1];
  return {
    prompt: display(args[0]),
    schema:
      schema !== null && typeof schema === "object"
        ? (schema as Record<string, unknown>)
        : undefined,
  };
}

function outputOf(entries: Entry[]): OutputLine[] {
  const lines: OutputLine[] = [];
  for (const entry of entries) {
    const args = argsOf(entry);
    if (entry["call"] === "view.show" && entry["pending"] === true) {
      const options = args[1] as { kind?: string } | undefined;
      lines.push({ kind: options?.kind === "tool" ? "tool" : "show", text: display(args[0]) });
    } else if (entry["call"] === "view.ask" && entry["pending"] === true) {
      lines.push({ kind: "ask", text: display(args[0]) });
    } else if (entry["call"] === "view.ask" && "outcome" in entry) {
      lines.push({ kind: "answer", text: display(entry["outcome"]) });
    }
  }
  return lines;
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
  const status = statusOf(notes, file.alive);
  // A run that is no longer running cannot take an answer, whatever its last ask says.
  const ask = status === "running" ? askOf(file.entries) : undefined;

  return {
    run: {
      id: file.id,
      name: text(renamed?.["name"]) ?? workflowName(workflow),
      status,
      dir: text(moved?.["dir"]) ?? cwd,
      ...(ask === undefined ? {} : { ask }),
      output: outputOf(file.entries),
      children: [],
    },
    parent: text(head["parent"]),
    root,
    at: text(head["at"]) ?? "",
  };
}

/** The run files as a tree of projects, grouped by each run's git root and linked by parent id. */
export function toProjects(files: RunFile[]): Project[] {
  const placed = files
    .map(place)
    .filter((entry): entry is Placed => entry !== undefined)
    .sort((a, b) => a.at.localeCompare(b.at));
  const byId = new Map(placed.map((entry) => [entry.run.id, entry]));
  const projects = new Map<string, Project>();

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
