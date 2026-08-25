import { useEffect, useRef } from "react";

import { nextView } from "@/lib/runs";
import type { Follow, Project } from "@/lib/runs";

/** Rides the output area up from a finished run and on into whatever its parent starts next. */
export function useFollow(
  projects: Project[],
  selectedId: string | undefined,
  suspended: boolean,
  onFollow: (id: string) => void,
): () => void {
  const before = useRef<Project[]>([]);
  const follow = useRef<Follow | undefined>(undefined);

  useEffect(() => {
    if (projects === before.current) return;
    const was = before.current;
    before.current = projects;
    // Taking the snapshot anyway keeps a finish behind the full terminal from firing later.
    if (suspended) {
      follow.current = undefined;
      return;
    }
    const move = nextView(was, projects, selectedId, follow.current);
    if (move === undefined) return;
    follow.current = move.follow;
    onFollow(move.select);
  }, [projects, selectedId, suspended, onFollow]);

  return () => {
    follow.current = undefined;
  };
}
