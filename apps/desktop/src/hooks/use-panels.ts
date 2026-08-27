import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

export type PanelName = "terminal" | "browser" | "diff";

/** The browser and the diff share the right column, so the browser's size is a height. */
export const PANEL_DEFAULTS = { terminal: 224, right: 460, browser: 420 } as const;
export const PANEL_MINIMUMS = {
  output: 240,
  terminal: 120,
  right: 320,
  browser: 160,
  diff: 160,
} as const;

type Sized = "terminal" | "right" | "browser";

/** What one run remembers: which panels it had open, which one filled the area, and their sizes. */
type Panels = {
  open: Record<PanelName, boolean>;
  full: PanelName | undefined;
  size: Partial<Record<Sized, number>>;
};

const SHUT: Panels = {
  open: { terminal: false, browser: false, diff: false },
  full: undefined,
  size: {},
};

export type PanelState = {
  open: (name: PanelName) => boolean;
  full: PanelName | undefined;
  toggle: (name: PanelName) => void;
  /** Opens the panel. One already open is left where it is, at the size it was left. */
  show: (name: PanelName) => void;
  close: (name: PanelName) => void;
  toggleFull: (name: PanelName) => void;
  /** Attach to the sized panels so their sizes can be read and restored. */
  terminalRef: (panel: PanelImperativeHandle | null) => void;
  rightRef: (panel: PanelImperativeHandle | null) => void;
  browserRef: (panel: PanelImperativeHandle | null) => void;
  /** Hand both groups' onLayoutChanged, so a finished drag is what the run remembers. */
  onDragged: (layout: unknown, meta: { isUserInteraction: boolean }) => void;
};

/**
 * Panels belong to the run, not the window. Switching runs restores what that run had open, at
 * the size it was left. This lives in memory only, the way every other read of a run does.
 */
export function usePanels(runId: string | undefined): PanelState {
  const [held, setHeld] = useState<Record<string, Panels>>({});
  const panels = useRef<Partial<Record<Sized, PanelImperativeHandle>>>({});
  // A panel joins its group's layout a render after it mounts. Resizing it any earlier throws.
  // So a size reaches a panel on the pass after the one that met it. An attachment schedules that
  // pass, before the switched run is painted.
  const known = useRef<Partial<Record<Sized, PanelImperativeHandle>>>({});
  const [attached, setAttached] = useState(0);
  const mine = runId === undefined ? SHUT : (held[runId] ?? SHUT);
  const size = mine.size;

  const change = useCallback(
    (edit: (panels: Panels) => Panels) => {
      if (runId === undefined) return;
      setHeld((all) => ({ ...all, [runId]: edit(all[runId] ?? SHUT) }));
    },
    [runId],
  );

  const toggle = useCallback(
    (name: PanelName) =>
      change((panels) => {
        const showing = !panels.open[name];
        return {
          ...panels,
          open: { ...panels.open, [name]: showing },
          full: showing || panels.full !== name ? panels.full : undefined,
        };
      }),
    [change],
  );

  const show = useCallback(
    (name: PanelName) =>
      change((panels) =>
        panels.open[name] ? panels : { ...panels, open: { ...panels.open, [name]: true } },
      ),
    [change],
  );

  const close = useCallback(
    (name: PanelName) =>
      change((panels) => ({
        ...panels,
        open: { ...panels.open, [name]: false },
        full: panels.full === name ? undefined : panels.full,
      })),
    [change],
  );

  const toggleFull = useCallback(
    (name: PanelName) =>
      change((panels) => ({ ...panels, full: panels.full === name ? undefined : name })),
    [change],
  );

  // Sizes go on before paint, so a switched run never flashes the last run's layout.
  useLayoutEffect(() => {
    for (const which of ["terminal", "right", "browser"] as const) {
      const panel = panels.current[which];
      if (panel !== undefined && panel === known.current[which]) {
        panel.resize(size[which] ?? PANEL_DEFAULTS[which]);
      }
    }
    known.current = { ...panels.current };
  }, [runId, size, attached]);

  const onDragged = useCallback(
    (_layout: unknown, meta: { isUserInteraction: boolean }) => {
      // Restoring a size reports here too. Only a drag or a resize key says what the run wants.
      if (!meta.isUserInteraction) return;
      change((held) => {
        const size = { ...held.size };
        for (const which of ["terminal", "right", "browser"] as const) {
          const found = panels.current[which]?.getSize().inPixels;
          if (found !== undefined) size[which] = Math.round(found);
        }
        return { ...held, size };
      });
    },
    [change],
  );

  const terminalRef = useCallback((panel: PanelImperativeHandle | null) => {
    if (panel === null) delete panels.current.terminal;
    else panels.current.terminal = panel;
    setAttached((count) => count + 1);
  }, []);

  const rightRef = useCallback((panel: PanelImperativeHandle | null) => {
    if (panel === null) delete panels.current.right;
    else panels.current.right = panel;
    setAttached((count) => count + 1);
  }, []);

  const browserRef = useCallback((panel: PanelImperativeHandle | null) => {
    if (panel === null) delete panels.current.browser;
    else panels.current.browser = panel;
    setAttached((count) => count + 1);
  }, []);

  return {
    open: (name) => mine.open[name],
    full: mine.full,
    toggle,
    show,
    close,
    toggleFull,
    terminalRef,
    rightRef,
    browserRef,
    onDragged,
  };
}
