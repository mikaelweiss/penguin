import { useEffect, useRef, useState, type RefObject } from "react";

import type { Tab } from "@/lib/browser";
import { surfacePass } from "@/lib/browser-surface";
import {
  browserBounds,
  browserClose,
  browserHide,
  browserOpen,
  browserShow,
  forgetTab,
  liveTabs,
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
  /** Every tab the app holds, every run. The pages belong to the window, not to one run. */
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
 * A tab gets its webview the first time it is looked at and keeps it until the tab closes, so
 * going back to a tab, in this run or in another one, finds the page where it was.
 */
export function useBrowserSurface({ mount, tabs, active, showing }: Surface): string | undefined {
  const at = useRef<Rect | undefined>(undefined);
  const tabsRef = useRef(tabs);
  const activeRef = useRef(active);
  const showingRef = useRef(showing);
  tabsRef.current = tabs;
  activeRef.current = active;
  showingRef.current = showing;
  const [error, setError] = useState<string | undefined>(undefined);
  const ids = tabs.map((tab) => tab.id).join("\0");

  // Close pages whose tabs left. Ids, not the tabs array: a title or url rewrite is not a close.
  useEffect(() => {
    const { close } = surfacePass({
      live: liveTabs(),
      tabs: tabsRef.current,
      active: activeRef.current,
      showing: showingRef.current,
    });
    for (const id of close) browserClose(id).catch(() => {});
  }, [ids]);

  // Open, show, hide, bounds. `tabs` stays in the ref so a title or url event cannot re-enter here.
  useEffect(() => {
    const showable = mount.current;
    const pass = surfacePass({
      live: liveTabs(),
      tabs: tabsRef.current,
      active,
      showing: showing && showable !== null,
    });
    for (const id of pass.close) browserClose(id).catch(() => {});

    if (pass.open !== undefined && showable !== null) {
      const rect = rectOf(showable);
      at.current = rect;
      const { id, url } = pass.open;
      browserOpen(id, url, rect).then(
        () => {
          setError(undefined);
          if (!liveTabs().has(id)) {
            browserClose(id).catch(() => {});
            return;
          }
          if (activeRef.current !== id || !showingRef.current) {
            browserHide(id).catch(() => {});
          }
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
      );
    } else if (pass.show !== undefined && showable !== null) {
      const rect = rectOf(showable);
      at.current = rect;
      const shown = pass.show;
      browserBounds(shown, rect).catch(() => forgetTab(shown));
      browserShow(shown).catch(() => forgetTab(shown));
    }

    for (const id of pass.hide) {
      browserHide(id).catch(() => forgetTab(id));
    }
  }, [mount, active, showing]);

  // Nothing measures the placeholder once the panel is gone, so a page left showing would sit over
  // the UI with no way to move it. The pages stay open: it is the panel that left, not the tabs.
  useEffect(
    () => () => {
      for (const id of liveTabs()) browserHide(id).catch(() => forgetTab(id));
    },
    [],
  );

  // The page has no layout of its own, so it follows the placeholder frame by frame: a panel drag,
  // a sidebar toggle, and a window resize all move the rect without changing anything React renders.
  useEffect(() => {
    if (!showing || active === undefined) return;
    let frame = 0;
    const follow = () => {
      frame = requestAnimationFrame(follow);
      const showable = mount.current;
      if (showable === null || !liveTabs().has(active)) return;
      const rect = rectOf(showable);
      if (sameRect(at.current, rect)) return;
      at.current = rect;
      browserBounds(active, rect).catch(() => forgetTab(active));
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [mount, active, showing]);

  return error;
}
