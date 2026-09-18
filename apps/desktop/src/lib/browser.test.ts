import { expect, test } from "bun:test";

import {
  applyOpens,
  blankTab,
  closeTab,
  forgetGone,
  landOpens,
  NO_TABS,
  openTab,
  pageUrl,
  shownUrl,
  typedUrl,
  type Held,
  type RunTabs,
} from "@/lib/browser";

function urls(held: RunTabs): string[] {
  return held.tabs.map((tab) => tab.url);
}

function activeUrl(held: RunTabs): string | undefined {
  return held.tabs.find((tab) => tab.id === held.active)?.url;
}

test("applying or opening a url on one run leaves another run's tabs alone", () => {
  const other = applyOpens(NO_TABS, ["https://b.test/", "https://b2.test/"]).next;
  let held: Held = { a: NO_TABS, b: other };

  held = { ...held, a: applyOpens(held.a ?? NO_TABS, ["https://a.test/"]).next };
  expect(held.b).toBe(other);
  expect(urls(held.b)).toEqual(["https://b.test/", "https://b2.test/"]);
  expect(held.b.active).toBe(other.active);
  expect(held.b.applied).toBe(other.applied);

  held = { ...held, a: openTab(held.a ?? NO_TABS, "https://a2.test/") };
  expect(held.b).toBe(other);
  expect(urls(held.b)).toEqual(["https://b.test/", "https://b2.test/"]);
  expect(held.b.active).toBe(other.active);
  expect(held.b.applied).toBe(other.applied);
});

test("three urls from one run are three tabs, the last one selected", () => {
  const { next, opened } = applyOpens(NO_TABS, [
    "https://a.test/",
    "https://b.test/",
    "https://c.test/",
  ]);
  expect(opened).toBe(true);
  expect(urls(next)).toEqual(["https://a.test/", "https://b.test/", "https://c.test/"]);
  expect(activeUrl(next)).toBe("https://c.test/");
});

test("a url a tab already holds is selected, never opened twice", () => {
  const first = applyOpens(NO_TABS, ["https://a.test/", "https://b.test/"]).next;
  const again = applyOpens(first, ["https://a.test/", "https://b.test/", "https://a.test/"]).next;
  expect(urls(again)).toEqual(["https://a.test/", "https://b.test/"]);
  expect(activeUrl(again)).toBe("https://a.test/");
});

test("the same notes applied twice open nothing the second time", () => {
  const opens = ["https://a.test/"];
  const first = applyOpens(NO_TABS, opens);
  const second = applyOpens(first.next, opens);
  expect(second.opened).toBe(false);
  expect(second.next).toBe(first.next);
});

test("a backlog from a run you were not watching arrives whole, once", () => {
  const backlog = ["https://a.test/", "https://b.test/"];
  const arrived = applyOpens(NO_TABS, backlog);
  expect(arrived.opened).toBe(true);
  expect(urls(arrived.next)).toHaveLength(2);
  expect(applyOpens(arrived.next, backlog).opened).toBe(false);
});

test("urls a run opened in one tick all arrive, however the polls fall across them", () => {
  // A run that opens three pages stamps all three with the same millisecond, so how far the
  // panel has read cannot be a time. Each poll below sees one more line of the same file.
  const all = ["https://a.test/", "https://b.test/", "https://c.test/"];
  let held = NO_TABS;
  for (const caught of [all.slice(0, 1), all.slice(0, 2), all]) {
    held = applyOpens(held, caught).next;
  }
  expect(urls(held)).toEqual(all);
});

test("a new tab is a tab you can see, waiting to be told where to go", () => {
  const held = blankTab(openTab(NO_TABS, "https://a.test/"));
  expect(held.tabs).toHaveLength(2);
  expect(held.tabs[1]?.url).toBe("");
  expect(held.active).toBe(held.tabs[1]!.id);
});

test("asking for a new tab again lands on the empty one already open", () => {
  const first = blankTab(NO_TABS);
  const again = blankTab(first);
  expect(again.tabs).toHaveLength(1);
  expect(again.active).toBe(first.tabs[0]!.id);
});

test("a url goes into the empty tab that is waiting, not a second one", () => {
  const held = openTab(blankTab(openTab(NO_TABS, "https://a.test/")), "https://b.test/");
  expect(urls(held)).toEqual(["https://a.test/", "https://b.test/"]);
  expect(activeUrl(held)).toBe("https://b.test/");
});

test("an empty tab nobody is looking at keeps its place", () => {
  const page = openTab(NO_TABS, "https://a.test/");
  const empty = blankTab(page);
  // Look away from the empty tab, then open a url. It belongs to no one now, so it is not taken.
  const looking = { ...empty, active: page.tabs[0]!.id };
  const opened = openTab(looking, "https://b.test/");
  expect(opened.tabs).toHaveLength(3);
  expect(opened.tabs.filter((tab) => tab.url === "")).toHaveLength(1);
  expect(activeUrl(opened)).toBe("https://b.test/");
});

test("closing the selected tab selects the one that took its place", () => {
  let held = NO_TABS;
  for (const url of ["https://a.test/", "https://b.test/", "https://c.test/"]) {
    held = openTab(held, url);
  }
  const middle = held.tabs[1]!;
  held = { ...held, active: middle.id };
  const after = closeTab(held, middle.id);
  expect(activeUrl(after)).toBe("https://c.test/");
});

test("closing the last tab falls back to the one before it", () => {
  let held = openTab(openTab(NO_TABS, "https://a.test/"), "https://b.test/");
  held = closeTab(held, held.tabs[1]!.id);
  expect(activeUrl(held)).toBe("https://a.test/");
});

test("closing the only tab leaves nothing selected", () => {
  const held = openTab(NO_TABS, "https://a.test/");
  expect(closeTab(held, held.tabs[0]!.id).active).toBeUndefined();
});

test("closing a tab that is not the selected one leaves the selection alone", () => {
  let held = openTab(openTab(NO_TABS, "https://a.test/"), "https://b.test/");
  held = closeTab(held, held.tabs[0]!.id);
  expect(activeUrl(held)).toBe("https://b.test/");
});

test("a run whose files are gone takes its tabs with it", () => {
  const held = { alive: NO_TABS, gone: NO_TABS };
  expect(Object.keys(forgetGone(held, new Set(["alive"])))).toEqual(["alive"]);
});

test("nothing gone means the same object back, so no write follows", () => {
  const held = { alive: NO_TABS };
  expect(forgetGone(held, new Set(["alive"]))).toBe(held);
});

test("a bare host is the url the person meant", () => {
  expect(typedUrl("localhost:5173")).toBe("http://localhost:5173/");
  expect(typedUrl("  github.com/o/r  ")).toBe("http://github.com/o/r");
  expect(typedUrl("https://github.com/o/r")).toBe("https://github.com/o/r");
});

test("what no browser can show is not navigated to", () => {
  expect(typedUrl("")).toBeUndefined();
  expect(typedUrl("file:///etc/passwd")).toBeUndefined();
  expect(typedUrl("javascript:alert(1)")).toBeUndefined();
});

/** What the platform hands back for a file, which the app never builds itself. */
function asset(path: string): string {
  return `asset://localhost/${encodeURIComponent(path)}`;
}

const PAGE = "/home/me/.penguin/briefs/penguin/ship/proposal.html";

function version(mark: string): string {
  return `${asset(PAGE)}?${mark}`;
}

test("a brief loads through the asset protocol, and the version it was asked for rides along", () => {
  expect(pageUrl(`file://${PAGE}?v=2`, asset)).toBe(version("v=2"));
  expect(pageUrl("https://example.test/a", asset)).toBe("https://example.test/a");
  expect(pageUrl("what a run wrote", asset)).toBe("what a run wrote");
});

test("a brief rendered again moves the tab already holding it instead of opening a second", () => {
  const first = landOpens(NO_TABS, [version("v=1")]);
  const tab = first.next.tabs[0]!.id;
  const second = landOpens(first.next, [version("v=2")]);

  expect(second.next.tabs).toHaveLength(1);
  expect(activeUrl(second.next)).toBe(version("v=2"));
  expect(second.moved).toEqual([{ id: tab, url: version("v=2") }]);
});

test("two briefs are two tabs, and a tab nothing moved is told nothing", () => {
  const other = `${asset("/home/me/.penguin/briefs/penguin/ship/review.html")}?v=1`;
  const landed = landOpens(NO_TABS, [version("v=1"), other]);

  expect(urls(landed.next)).toEqual([version("v=1"), other]);
  expect(landed.moved).toEqual([]);
});

test("an older version of the same brief is a tab of its own, not the page the run opened", () => {
  const older = asset("/home/me/.penguin/briefs/penguin/ship/history/proposal.v1.html");
  const landed = landOpens(NO_TABS, [version("v=2"), older]);

  expect(urls(landed.next)).toEqual([version("v=2"), older]);
  expect(landed.moved).toEqual([]);
});

test("the address bar says the file a brief came from, which no one can type back at it", () => {
  expect(shownUrl(version("v=2"))).toBe(`file://${PAGE}?v=2`);
  expect(shownUrl("https://example.test/a")).toBe("https://example.test/a");
  expect(typedUrl(shownUrl(version("v=2")))).toBeUndefined();
});
