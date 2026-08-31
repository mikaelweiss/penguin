import { expect, test } from "bun:test";

import type { Tab } from "@/lib/browser";
import { surfacePass } from "@/lib/browser-surface";

function tab(id: string, url: string, title = ""): Tab {
  return { id, url, title };
}

test("a tab already live is shown in place, never opened", () => {
  const pass = surfacePass({
    live: new Set(["a", "b"]),
    tabs: [tab("a", "https://a.test/"), tab("b", "https://b.test/")],
    active: "a",
    showing: true,
  });
  expect(pass.open).toBeUndefined();
  expect(pass.show).toBe("a");
  expect(pass.bounds).toBe("a");
  expect(pass.hide).toEqual(["b"]);
  expect(pass.close).toEqual([]);
});

test("a new tabs array with the same ids does not open", () => {
  const live = new Set(["a"]);
  const first = surfacePass({
    live,
    tabs: [tab("a", "https://a.test/", "One")],
    active: "a",
    showing: true,
  });
  expect(first.open).toBeUndefined();
  const again = surfacePass({
    live,
    tabs: [tab("a", "https://a.test/other", "Two")],
    active: "a",
    showing: true,
  });
  expect(again.open).toBeUndefined();
  expect(again.show).toBe("a");
});

test("a first look opens once, and a tab that left is closed", () => {
  const pass = surfacePass({
    live: new Set(["gone", "a"]),
    tabs: [tab("a", "https://a.test/"), tab("b", "https://b.test/")],
    active: "b",
    showing: true,
  });
  expect(pass.close).toEqual(["gone"]);
  expect(pass.open).toEqual({ id: "b", url: "https://b.test/" });
  expect(pass.hide).toEqual(["a"]);
  expect(pass.show).toBeUndefined();
});

test("another run's page is hidden, not closed, so a switch back does not reload it", () => {
  const pass = surfacePass({
    live: new Set(["a"]),
    tabs: [tab("a", "https://a.test/"), tab("b", "https://b.test/")],
    active: "b",
    showing: true,
  });
  expect(pass.close).toEqual([]);
  expect(pass.hide).toEqual(["a"]);

  const back = surfacePass({
    live: new Set(["a", "b"]),
    tabs: [tab("a", "https://a.test/"), tab("b", "https://b.test/")],
    active: "a",
    showing: true,
  });
  expect(back.open).toBeUndefined();
  expect(back.show).toBe("a");
});
