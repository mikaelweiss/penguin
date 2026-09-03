import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { PANEL_SIDEBAR } from "@/components/panel-sidebar-handle";
import { readPanels, writePanels, type BaseChoice } from "@/lib/files";
import type { SessionTabState } from "@/lib/layout-tabs";

export type PanelName = "terminal" | "browser" | "files" | "info";

/** The browser and the files panel share the right column, so the browser's size is a height. */
export const PANEL_DEFAULTS = { terminal: 224, right: 460, browser: 420 } as const;
export const PANEL_MINIMUMS = {
  output: 240,
  terminal: 120,
  right: 320,
  browser: 160,
  files: 160,
  info: 160,
} as const;

type Sized = "terminal" | "right" | "browser";

export type DiffStyle = "unified" | "split";
export type ExpandMode = "expand" | "collapse";

/** What one run remembers: its panels, their sizes, its open file tabs, and its base. */
export type RunPanels = {
  open: Record<PanelName, boolean>;
  full?: PanelName;
  size: Partial<Record<Sized, number>>;
  tabs: SessionTabState;
  base: BaseChoice;
};

/** What every run shares: how the review is drawn, and how wide its sidebar is. */
export type GlobalPanels = {
  sidebarOpen: boolean;
  sidebarWidth: number;
  expandMode: ExpandMode;
  diffStyle: DiffStyle;
};

export type PanelStore = { global: GlobalPanels; runs: Record<string, RunPanels> };

export const SHUT: RunPanels = {
  open: { terminal: false, browser: false, files: false, info: false },
  full: undefined,
  size: {},
  tabs: { tabs: { all: [], active: undefined }, preview: undefined },
  base: "auto",
};

export const GLOBAL_DEFAULTS: GlobalPanels = {
  sidebarOpen: true,
  sidebarWidth: PANEL_SIDEBAR.default,
  expandMode: "collapse",
  diffStyle: "unified",
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
  /** This run's tab state, the input and output of @/lib/layout-tabs. */
  tabs: SessionTabState;
  setTabs: (next: SessionTabState) => void;
  base: BaseChoice;
  setBase: (base: BaseChoice) => void;
  global: GlobalPanels;
  setGlobal: (edit: Partial<GlobalPanels>) => void;
  /** Drops the state of every run outside the live set. */
  prune: (live: ReadonlySet<string>) => void;
};

/** How long a change waits before it reaches the file, so a drag writes once rather than per frame. */
const WRITE_SETTLE_MS = 200;

const BLANK: PanelStore = { global: GLOBAL_DEFAULTS, runs: {} };
const PANEL_NAMES = ["terminal", "browser", "files", "info"] as const;
const SIZED = ["terminal", "right", "browser"] as const;
const BASES = ["auto", "head", "branch"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A width the handle could never have produced is a width the sidebar must not wear. */
export function sidebarWidth(value: unknown): number {
  const held = number(value, GLOBAL_DEFAULTS.sidebarWidth);
  return Math.min(PANEL_SIDEBAR.max, Math.max(PANEL_SIDEBAR.min, Math.round(held)));
}

function readGlobal(value: unknown): GlobalPanels {
  if (!isRecord(value)) return GLOBAL_DEFAULTS;
  const expand = value.expandMode;
  const style = value.diffStyle;
  return {
    sidebarOpen:
      typeof value.sidebarOpen === "boolean" ? value.sidebarOpen : GLOBAL_DEFAULTS.sidebarOpen,
    sidebarWidth: sidebarWidth(value.sidebarWidth),
    expandMode: expand === "expand" || expand === "collapse" ? expand : GLOBAL_DEFAULTS.expandMode,
    diffStyle: style === "unified" || style === "split" ? style : GLOBAL_DEFAULTS.diffStyle,
  };
}

function readTabs(value: unknown): SessionTabState {
  if (!isRecord(value)) return SHUT.tabs;
  const held: Record<string, unknown> = isRecord(value.tabs) ? value.tabs : {};
  const all = Array.isArray(held.all)
    ? held.all.filter((tab): tab is string => typeof tab === "string")
    : [];
  return {
    tabs: { all, active: typeof held.active === "string" ? held.active : undefined },
    preview: typeof value.preview === "string" ? value.preview : undefined,
  };
}

function readRun(value: unknown): RunPanels {
  if (!isRecord(value)) return SHUT;
  const open = { ...SHUT.open };
  if (isRecord(value.open)) {
    for (const name of PANEL_NAMES) {
      const found = value.open[name];
      if (typeof found === "boolean") open[name] = found;
    }
  }
  const size: Partial<Record<Sized, number>> = {};
  if (isRecord(value.size)) {
    for (const which of SIZED) {
      const found = value.size[which];
      if (typeof found === "number" && Number.isFinite(found)) size[which] = found;
    }
  }
  return {
    open,
    full: PANEL_NAMES.find((name) => name === value.full),
    size,
    tabs: readTabs(value.tabs),
    base: BASES.find((choice) => choice === value.base) ?? SHUT.base,
  };
}

export function readStore(value: unknown): PanelStore {
  if (!isRecord(value)) return BLANK;
  const runs: Record<string, RunPanels> = {};
  if (isRecord(value.runs)) {
    for (const [runId, held] of Object.entries(value.runs)) runs[runId] = readRun(held);
  }
  return { global: readGlobal(value.global), runs };
}

/** Drops every run outside the live set, and keeps the store itself when none goes. */
export function pruneRuns(store: PanelStore, live: ReadonlySet<string>): PanelStore {
  const kept = Object.entries(store.runs).filter(([runId]) => live.has(runId));
  if (kept.length === Object.keys(store.runs).length) return store;
  return { ...store, runs: Object.fromEntries(kept) };
}

/**
 * Panels belong to the run, not the window, and outlive a quit: switching runs or relaunching the
 * app restores what that run had open, at the size it was left, with the same file tabs.
 */
export function usePanels(runId: string | undefined): PanelState {
  const [store, setStore] = useState<PanelStore>(BLANK);
  // What the file already holds. Nothing is written until the first read lands on it.
  const saved = useRef<PanelStore | undefined>(undefined);
  const pending = useRef<PanelStore | undefined>(undefined);
  const panels = useRef<Partial<Record<Sized, PanelImperativeHandle>>>({});
  // A panel joins its group's layout a render after it mounts. Resizing it any earlier throws.
  // So a size reaches a panel on the pass after the one that met it. An attachment schedules that
  // pass, before the switched run is painted.
  const known = useRef<Partial<Record<Sized, PanelImperativeHandle>>>({});
  const [attached, setAttached] = useState(0);
  const mine = runId === undefined ? SHUT : (store.runs[runId] ?? SHUT);
  const size = mine.size;

  useEffect(() => {
    readPanels().then(
      (read) => {
        const held = readStore(read);
        saved.current = held;
        setStore(held);
      },
      () => {
        saved.current = BLANK;
      },
    );
  }, []);

  useEffect(() => {
    if (saved.current === undefined || saved.current === store) return;
    pending.current = store;
    const timer = window.setTimeout(() => {
      pending.current = undefined;
      saved.current = store;
      writePanels(store).catch(() => {});
    }, WRITE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [store]);

  /** Sends what the debounce still holds, so a change made just before a quit still lands. */
  const flush = useCallback(async () => {
    const last = pending.current;
    if (last === undefined) return;
    pending.current = undefined;
    saved.current = last;
    await writePanels(last).catch(() => {});
  }, []);

  useEffect(
    () => () => {
      void flush();
    },
    [flush],
  );

  // Unmounting is not what a quit does: the window asks, waits for this handler, and then goes.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let dropped = false;

    getCurrentWindow()
      .onCloseRequested(flush)
      .then((off) => {
        if (dropped) off();
        else stop = off;
      })
      .catch(() => {});

    return () => {
      dropped = true;
      stop?.();
    };
  }, [flush]);

  const change = useCallback(
    (edit: (panels: RunPanels) => RunPanels) => {
      if (runId === undefined) return;
      setStore((all) => ({
        ...all,
        runs: { ...all.runs, [runId]: edit(all.runs[runId] ?? SHUT) },
      }));
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

  const setTabs = useCallback(
    (next: SessionTabState) => change((panels) => ({ ...panels, tabs: next })),
    [change],
  );

  const setBase = useCallback(
    (base: BaseChoice) => change((panels) => ({ ...panels, base })),
    [change],
  );

  const setGlobal = useCallback(
    (edit: Partial<GlobalPanels>) =>
      setStore((all) => ({ ...all, global: { ...all.global, ...edit } })),
    [],
  );

  const prune = useCallback((live: ReadonlySet<string>) => {
    setStore((all) => pruneRuns(all, live));
  }, []);

  // Sizes go on before paint, so a switched run never flashes the last run's layout.
  useLayoutEffect(() => {
    for (const which of SIZED) {
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
        for (const which of SIZED) {
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
    tabs: mine.tabs,
    setTabs,
    base: mine.base,
    setBase,
    global: store.global,
    setGlobal,
    prune,
  };
}
