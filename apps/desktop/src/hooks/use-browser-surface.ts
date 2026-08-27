import { useEffect, useRef, useState, type RefObject } from "react";

import type { Tab } from "@/lib/browser";
import {
  browserBounds,
  browserClose,
  browserHide,
  browserOpen,
  browserShow,
  type Rect,
} from "@/lib/webview";

function sameRect(a: Rect | undefined, b: Rect): boolean {
  return a !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function rectOf(mount: HTMLDivElement): Rect {
  const box = mount.getBoundingClientRect();
  return {
    x: Math.round(box.left),
    y: Math.round(box.top),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

type Surface = {
  mount: RefObject<HTMLDivElement | null>;
  runId: string | undefined;
  tabs: Tab[];
  active: string | undefined;
  /** False whenever something must draw over the page: a dialog, a full screen sibling, no panel. */
  showing: boolean;
};

/**
 * Keeps the native webviews under the panel's placeholder. Tauri draws a child webview above the
 * React tree, so nothing here is layout: the page is positioned at the rect the placeholder
 * measures, and hidden outright whenever the app needs to draw on top of it.
 *
 * A tab gets its webview the first time it is looked at and keeps it until the tab closes or the
 * run is left, so going back to a tab finds the page where it was.
 */
export function useBrowserSurface({ mount, runId, tabs, active, showing }: Surface): string | undefined {
  const live = useRef<Set<string>>(new Set());
  const at = useRef<Rect | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  // Leaving a run closes its pages. Only what you are looking at costs a webview.
  useEffect(
    () => () => {
      for (const id of live.current) browserClose(id).catch(() => {});
      live.current.clear();
      at.current = undefined;
    },
    [runId],
  );

  useEffect(() => {
    const known = new Set(tabs.map((tab) => tab.id));
    for (const id of live.current) {
      if (known.has(id)) continue;
      browserClose(id).catch(() => {});
      live.current.delete(id);
    }

    const showable = mount.current;
    const tab = tabs.find((one) => one.id === active);
    if (!showing || showable === null || tab === undefined) {
      for (const id of live.current) browserHide(id).catch(() => {});
      return;
    }

    const rect = rectOf(showable);
    at.current = rect;
    if (live.current.has(tab.id)) {
      browserBounds(tab.id, rect).catch(() => {});
      browserShow(tab.id).catch(() => {});
    } else {
      live.current.add(tab.id);
      browserOpen(tab.id, tab.url, rect).then(
        () => setError(undefined),
        (cause: unknown) => {
          live.current.delete(tab.id);
          setError(cause instanceof Error ? cause.message : String(cause));
        },
      );
    }
    for (const id of live.current) {
      if (id !== tab.id) browserHide(id).catch(() => {});
    }
  }, [mount, runId, tabs, active, showing]);

  // The page has no layout of its own, so it follows the placeholder frame by frame: a panel drag,
  // a sidebar toggle, and a window resize all move the rect without changing anything React renders.
  useEffect(() => {
    if (!showing || active === undefined) return;
    let frame = 0;
    const follow = () => {
      frame = requestAnimationFrame(follow);
      const showable = mount.current;
      if (showable === null || !live.current.has(active)) return;
      const rect = rectOf(showable);
      if (sameRect(at.current, rect)) return;
      at.current = rect;
      browserBounds(active, rect).catch(() => {});
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [mount, active, showing]);

  return error;
}
