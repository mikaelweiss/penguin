import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { notifyNeedsYou, onNeedsYouClick } from "@/lib/notifications";
import { findRun, needsYou, needsYouNotice, newlyBlocked } from "@/lib/runs";
import type { Project } from "@/lib/runs";

/** Tells the OS when a run starts waiting on a person, and opens that run when the notice is clicked. */
export function useNeedsYou(
  projects: Project[],
  published: boolean,
  onOpen: (id: string) => void,
): void {
  const before = useRef<Project[]>([]);
  const seeded = useRef(false);
  const latest = useRef({ projects, onOpen });

  useEffect(() => {
    latest.current = { projects, onOpen };
  });

  useEffect(() => {
    if (!published) return;
    if (projects === before.current) return;
    const was = before.current;
    before.current = projects;
    // The runs already waiting when the app opened are not news, so the first tree only seeds.
    if (!seeded.current) {
      seeded.current = true;
      return;
    }
    for (const run of newlyBlocked(was, projects)) {
      const notice = needsYouNotice(run);
      if (notice === undefined) continue;
      notifyNeedsYou(run.id, notice.title, notice.body).catch(() => {});
    }
  }, [projects, published]);

  useEffect(() => {
    let dead = false;
    let unlisten: UnlistenFn | undefined;

    onNeedsYouClick((id) => {
      const { projects: shown, onOpen: open } = latest.current;
      // A notification outlives the wait it was posted for, so a stale click moves nothing.
      const node = findRun(shown, id);
      if (node === undefined || !needsYou(node.run)) return;
      open(id);
      const window = getCurrentWindow();
      window
        .show()
        .then(() => window.unminimize())
        .then(() => window.setFocus())
        .catch(() => {});
    })
      .then((off) => {
        if (dead) off();
        else unlisten = off;
      })
      .catch(() => {});

    return () => {
      dead = true;
      unlisten?.();
    };
  }, []);
}
