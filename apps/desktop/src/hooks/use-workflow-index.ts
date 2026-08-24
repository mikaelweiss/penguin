import { useEffect, useState } from "react";

import type { Project } from "@/lib/runs";
import { describe } from "@/lib/workflows";
import type { Workflow } from "@/lib/workflows";

export type Startable = {
  workflow: Workflow;
  project: Project;
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

  const startable = projects.flatMap((project) =>
    (byDir[project.dir] ?? [])
      .filter((workflow) => workflow.error === undefined)
      .map((workflow) => ({ workflow, project })),
  );

  return { startable, reading };
}
