export type RunStatus = "running" | "done" | "failed" | "stopped" | "crashed";

export type OutputLine = {
  kind: "show" | "tool" | "ask" | "answer" | "message";
  text: string;
};

export type Ask = {
  prompt: string;
  choices: string[];
  many: boolean;
  other: boolean;
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
