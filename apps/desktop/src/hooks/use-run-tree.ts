import { useState } from "react";

import { isLive } from "@/lib/runs";
import type { RunNode } from "@/lib/runs";

export type RunTree = {
  collapsed: ReadonlySet<string>;
  finished: ReadonlySet<string>;
  toggleRun: (id: string) => void;
  toggleFinished: (id: string) => void;
  /** Opens the rows a run hides behind, so selecting it anywhere puts it on screen. */
  reveal: (node: RunNode) => void;
};

function flip(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** Which runs the sidebar folds away, held where every frontend of the tree can reach it. */
export function useRunTree(): RunTree {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [finished, setFinished] = useState<ReadonlySet<string>>(new Set());

  return {
    collapsed,
    finished,
    toggleRun: (id) => setCollapsed((current) => flip(current, id)),
    toggleFinished: (id) => setFinished((current) => flip(current, id)),
    reveal: (node) => {
      setCollapsed((current) => {
        const next = new Set(current);
        for (const ancestor of node.ancestors) next.delete(ancestor.id);
        return next.size === current.size ? current : next;
      });
      if (isLive(node.run)) return;
      setFinished((current) =>
        current.has(node.project.id) ? current : new Set(current).add(node.project.id),
      );
    },
  };
}
