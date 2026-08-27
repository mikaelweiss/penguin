import { expect, test } from "bun:test";

import {
  applyOpens,
  closeTab,
  forgetGone,
  NO_TABS,
  openTab,
  typedUrl,
  type RunTabs,
} from "@/lib/browser";

function urls(held: RunTabs): string[] {
  return held.tabs.map((tab) => tab.url);
}

function activeUrl(held: RunTabs): string | undefined {
  return held.tabs.find((tab) => tab.id === held.active)?.url;
}

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
