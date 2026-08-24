import { useEffect, useState } from "react";

import type { Project } from "@/lib/runs";
import { describe } from "@/lib/workflows";
import type { Workflow } from "@/lib/workflows";

export type Startable = {
  workflow: Workflow;
  /** Every project that can reach this file. A shared catalog puts many here. */
  projects: Project[];
};

export type WorkflowIndex = {
  startable: Startable[];
  reading: boolean;
};

/**
 * Every workflow each project can reach. Reading costs one engine run per project,
 * so it waits until something wants the list, then holds it until the projects change.
 */
export function useWorkflowIndex(projects: Project[], wanted: boolean): WorkflowIndex {
  const [byDir, setByDir] = useState<Record<string, Workflow[]>>({});
  const [reading, setReading] = useState(false);
  const [asked, setAsked] = useState(false);
  const dirs = projects.map((project) => project.dir).join("\n");

  useEffect(() => {
    if (wanted) setAsked(true);
  }, [wanted]);

  useEffect(() => {
    if (!asked || dirs === "") return;
    let stopped = false;
    setReading(true);
    const read = dirs.split("\n").map((dir) =>
      describe(dir).then(
        (catalogs) => [dir, catalogs.workflows] as const,
        () => [dir, []] as const,
      ),
    );
    Promise.all(read).then((pairs) => {
      if (stopped) return;
      setByDir(Object.fromEntries(pairs));
      setReading(false);
    });
    return () => {
      stopped = true;
    };
  }, [asked, dirs]);

  return { startable: gather(projects, byDir), reading };
}

/** One row per workflow file, carrying every project that can reach it. */
function gather(projects: Project[], byDir: Record<string, Workflow[]>): Startable[] {
  const byFile = new Map<string, Startable>();

  for (const project of projects) {
    for (const workflow of byDir[project.dir] ?? []) {
      if (workflow.error !== undefined) continue;
      const found = byFile.get(workflow.file);
      if (found === undefined) byFile.set(workflow.file, { workflow, projects: [project] });
      else found.projects.push(project);
    }
  }

  return [...byFile.values()];
}
