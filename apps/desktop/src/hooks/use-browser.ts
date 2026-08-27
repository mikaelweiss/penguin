import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  blankTab,
  closeTab,
  forgetGone,
  freshOpens,
  navigate,
  NO_TABS,
  openTab,
  retitle,
  type Held,
  type RunTabs,
} from "@/lib/browser";
import {
  browserReset,
  onBrowserPopup,
  onBrowserTitle,
  onBrowserUrl,
  readBrowser,
  writeBrowser,
} from "@/lib/webview";

/** Where a run's urls land: a tab in the panel, or whatever browser the machine opens. */
export type OpenIn = "app" | "system";

export type BrowserState = {
  /** One run's tabs. A run with none reads as empty, never undefined. */
  of: (runId: string | undefined) => RunTabs;
  open: (runId: string, url: string) => void;
  close: (runId: string, tabId: string) => void;
  select: (runId: string, tabId: string) => void;
  /** Opens a tab with nowhere to go yet, so the url field starts empty over the landing page. */
  newTab: (runId: string) => void;
  go: (runId: string, tabId: string, url: string) => void;
  /**
   * Lands a run's open notes. Returns true when any were news, which is what decides whether the
   * panel shows itself. Applying the same notes again is a no-op, whichever browser they go to.
   */
  apply: (runId: string, opens: string[], into: OpenIn) => boolean;
  /** Drops the tabs of runs that no longer exist. */
  prune: (live: ReadonlySet<string>) => void;
  error: string | undefined;
};

function problem(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The browser panel's tabs, per run, kept in the app's own config. Unlike the panel layout these
 * outlive a quit: a run's pull request is still there when you come back to it tomorrow.
 */
export function useBrowser(): BrowserState {
  const [held, setHeld] = useState<Held>({});
  const [error, setError] = useState<string | undefined>(undefined);
  // What the file already holds. Nothing is written until the first read lands on it.
  const saved = useRef<Held | undefined>(undefined);

  useEffect(() => {
    browserReset().catch(() => {});
    readBrowser().then(
      (read) => {
        saved.current = read;
        setHeld(read);
      },
      (cause: unknown) => {
        saved.current = {};
        setError(problem(cause));
      },
    );
  }, []);

  useEffect(() => {
    if (saved.current === undefined || saved.current === held) return;
    saved.current = held;
    writeBrowser(held).then(
      () => setError(undefined),
      (cause: unknown) => setError(problem(cause)),
    );
  }, [held]);

  const change = useCallback(
    (runId: string, edit: (held: RunTabs) => RunTabs) =>
      setHeld((all) => ({ ...all, [runId]: edit(all[runId] ?? NO_TABS) })),
    [],
  );

  // A page that navigates itself, or a title that arrives late, belongs to whichever run holds it.
  const editTab = useCallback((tabId: string, edit: (held: RunTabs) => RunTabs) => {
    setHeld((all) => {
      for (const [runId, one] of Object.entries(all)) {
        if (one.tabs.some((tab) => tab.id === tabId)) return { ...all, [runId]: edit(one) };
      }
      return all;
    });
  }, []);

  useEffect(() => {
    const stopping = [
      onBrowserUrl((tabId, url) => editTab(tabId, (one) => navigate(one, tabId, url))),
      onBrowserTitle((tabId, title) => editTab(tabId, (one) => retitle(one, tabId, title))),
      onBrowserPopup((tabId, url) => editTab(tabId, (one) => openTab(one, url))),
    ];
    return () => {
      for (const pending of stopping) pending.then((stop) => stop()).catch(() => {});
    };
  }, [editTab]);

  const prune = useCallback(
    (live: ReadonlySet<string>) => setHeld((all) => forgetGone(all, live)),
    [],
  );

  const apply = useCallback(
    (runId: string, opens: string[], into: OpenIn): boolean => {
      const one = held[runId] ?? NO_TABS;
      const { urls, applied } = freshOpens(one, opens);
      if (urls.length === 0) return false;
      if (into === "system") {
        for (const url of urls) openUrl(url).catch((cause: unknown) => setError(problem(cause)));
        change(runId, (held) => ({ ...held, applied }));
        return true;
      }
      let next = one;
      for (const url of urls) next = openTab(next, url);
      change(runId, () => ({ ...next, applied }));
      return true;
    },
    [held, change],
  );

  return {
    of: (runId) => (runId === undefined ? NO_TABS : (held[runId] ?? NO_TABS)),
    open: (runId, url) => change(runId, (one) => openTab(one, url)),
    close: (runId, tabId) => change(runId, (one) => closeTab(one, tabId)),
    select: (runId, tabId) => change(runId, (one) => ({ ...one, active: tabId })),
    newTab: (runId) => change(runId, blankTab),
    go: (runId, tabId, url) => change(runId, (one) => navigate(one, tabId, url)),
    apply,
    prune,
    error,
  };
}
