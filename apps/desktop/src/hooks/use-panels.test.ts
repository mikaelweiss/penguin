import { describe, expect, test } from "bun:test";

import { PANEL_SIDEBAR } from "@/components/panel-sidebar-handle";
import {
  GLOBAL_DEFAULTS,
  SHUT,
  pruneRuns,
  readStore,
  sidebarWidth,
  type PanelStore,
} from "@/hooks/use-panels";

const stored: PanelStore = {
  global: { sidebarOpen: false, sidebarWidth: 300, expandMode: "expand", diffStyle: "split" },
  runs: {
    "run-a": {
      open: { terminal: true, browser: false, files: true, info: false },
      full: "files",
      size: { terminal: 200, right: 500, browser: 380 },
      tabs: {
        tabs: { all: ["file://a.ts", "file://b.ts"], active: "file://b.ts" },
        preview: "file://b.ts",
      },
      base: "branch",
    },
  },
};

const run = (edit: Partial<PanelStore["runs"][string]>): PanelStore["runs"][string] => ({
  ...SHUT,
  ...edit,
});

describe("readStore", () => {
  test("hydrates an empty document to the defaults", () => {
    expect(readStore({})).toEqual({ global: GLOBAL_DEFAULTS, runs: {} });
  });

  test("hydrates a document that is not an object", () => {
    for (const value of [undefined, null, 7, "panels", [], true]) {
      expect(readStore(value)).toEqual({ global: GLOBAL_DEFAULTS, runs: {} });
    }
  });

  test("round-trips a valid document unchanged", () => {
    expect(readStore(structuredClone(stored))).toEqual(stored);
  });

  test("drops a global block of the wrong shape", () => {
    expect(readStore({ global: "wide" }).global).toEqual(GLOBAL_DEFAULTS);
    expect(readStore({ global: [] }).global).toEqual(GLOBAL_DEFAULTS);
  });

  test("drops each corrupt global field on its own", () => {
    expect(
      readStore({
        global: { sidebarOpen: "yes", sidebarWidth: "wide", expandMode: "grow", diffStyle: 3 },
      }).global,
    ).toEqual(GLOBAL_DEFAULTS);
  });

  test("keeps the sound global fields beside the corrupt ones", () => {
    expect(
      readStore({ global: { sidebarOpen: false, expandMode: "grow", diffStyle: "split" } }).global,
    ).toEqual({ ...GLOBAL_DEFAULTS, sidebarOpen: false, diffStyle: "split" });
  });

  test("drops a run of the wrong shape", () => {
    expect(readStore({ runs: { "run-a": "open", "run-b": 4 } }).runs).toEqual({
      "run-a": SHUT,
      "run-b": SHUT,
    });
  });

  test("ignores runs held under something that is not an object", () => {
    expect(readStore({ runs: ["run-a"] }).runs).toEqual({});
  });

  test("keeps only the panel names it knows", () => {
    expect(
      readStore({
        runs: { "run-a": { open: { terminal: true, sidebar: true, info: "yes" } } },
      }).runs["run-a"],
    ).toEqual(run({ open: { ...SHUT.open, terminal: true } }));
  });

  test("drops an unknown panel from full", () => {
    expect(readStore({ runs: { "run-a": { full: "sidebar" } } }).runs["run-a"]?.full).toBeUndefined();
  });

  test("drops an unknown base", () => {
    expect(readStore({ runs: { "run-a": { base: "origin/main" } } }).runs["run-a"]?.base).toBe(
      "auto",
    );
  });

  test("drops non-finite and non-numeric sizes", () => {
    expect(
      readStore({
        runs: {
          "run-a": {
            size: { terminal: Number.NaN, right: Number.POSITIVE_INFINITY, browser: "420" },
          },
        },
      }).runs["run-a"]?.size,
    ).toEqual({});
  });

  test("keeps the sizes that are real numbers", () => {
    expect(
      readStore({ runs: { "run-a": { size: { terminal: 200, right: Number.NaN } } } }).runs["run-a"]
        ?.size,
    ).toEqual({ terminal: 200 });
  });

  test("drops tabs that are not strings", () => {
    expect(
      readStore({
        runs: {
          "run-a": {
            tabs: { tabs: { all: ["file://a.ts", 5, null], active: 7 }, preview: {} },
          },
        },
      }).runs["run-a"]?.tabs,
    ).toEqual({ tabs: { all: ["file://a.ts"], active: undefined }, preview: undefined });
  });

  test("drops a tab list of the wrong shape", () => {
    expect(readStore({ runs: { "run-a": { tabs: { tabs: "all" } } } }).runs["run-a"]?.tabs).toEqual(
      SHUT.tabs,
    );
  });

  test("clamps a sidebar width outside the handle's bounds", () => {
    expect(readStore({ global: { sidebarWidth: 9000 } }).global.sidebarWidth).toBe(
      PANEL_SIDEBAR.max,
    );
    expect(readStore({ global: { sidebarWidth: 4 } }).global.sidebarWidth).toBe(PANEL_SIDEBAR.min);
  });
});

describe("sidebarWidth", () => {
  test("keeps a width the handle could have produced", () => {
    expect(sidebarWidth(300)).toBe(300);
  });

  test("clamps to the handle's bounds", () => {
    expect(sidebarWidth(PANEL_SIDEBAR.max + 1)).toBe(PANEL_SIDEBAR.max);
    expect(sidebarWidth(PANEL_SIDEBAR.min - 1)).toBe(PANEL_SIDEBAR.min);
  });

  test("rounds a fractional width", () => {
    expect(sidebarWidth(300.6)).toBe(301);
  });

  test("falls back for a width that is not a finite number", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, "300", undefined, null]) {
      expect(sidebarWidth(value)).toBe(GLOBAL_DEFAULTS.sidebarWidth);
    }
  });
});

describe("pruneRuns", () => {
  test("drops the runs outside the live set and keeps the rest", () => {
    const store: PanelStore = {
      global: GLOBAL_DEFAULTS,
      runs: { "run-a": run({ base: "head" }), "run-b": SHUT, "run-c": run({ base: "branch" }) },
    };
    expect(pruneRuns(store, new Set(["run-a", "run-c"])).runs).toEqual({
      "run-a": run({ base: "head" }),
      "run-c": run({ base: "branch" }),
    });
  });

  test("keeps the global block", () => {
    const global = { ...GLOBAL_DEFAULTS, sidebarOpen: false, sidebarWidth: 300 };
    expect(pruneRuns({ global, runs: { "run-a": SHUT } }, new Set()).global).toEqual(global);
  });

  test("empties the runs when nothing is live", () => {
    expect(pruneRuns({ global: GLOBAL_DEFAULTS, runs: { "run-a": SHUT } }, new Set()).runs).toEqual(
      {},
    );
  });

  test("returns the same store when every run is live", () => {
    const store: PanelStore = { global: GLOBAL_DEFAULTS, runs: { "run-a": SHUT } };
    expect(pruneRuns(store, new Set(["run-a", "run-b"]))).toBe(store);
  });
});
