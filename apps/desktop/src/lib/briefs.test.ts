import { expect, test } from "bun:test";

import { briefImage, briefPage, briefsRoot } from "@/lib/briefs";

const ROOT = briefsRoot("/home/me");

test("the root sits under the home folder, however the platform spells it", () => {
  expect(ROOT).toBe("/home/me/.penguin/briefs/");
  expect(briefsRoot("/home/me/")).toBe(ROOT);
});

test("a page is html the engine wrote, named by a file url", () => {
  expect(briefPage(`file://${ROOT}penguin/ship/proposal.html?v=2`, ROOT)).toBe(
    `${ROOT}penguin/ship/proposal.html`,
  );
  expect(briefPage(`file://${ROOT}penguin/ship/notes.md`, ROOT)).toBeUndefined();
  expect(briefPage("file:///etc/passwd.html", ROOT)).toBeUndefined();
  expect(briefPage("https://example.test/a.html", ROOT)).toBeUndefined();
  expect(briefPage("what a run wrote", ROOT)).toBeUndefined();
});

test("a picture is a path under the root that stays under it", () => {
  expect(briefImage(`${ROOT}penguin/ship/review.png`, ROOT)).toBe(`${ROOT}penguin/ship/review.png`);
  expect(briefImage(`${ROOT}../../.ssh/id_rsa`, ROOT)).toBeUndefined();
  expect(briefImage("/etc/passwd", ROOT)).toBeUndefined();
});

test("with no root in hand nothing is a brief", () => {
  expect(briefPage(`file://${ROOT}penguin/ship/proposal.html`, undefined)).toBeUndefined();
  expect(briefImage(`${ROOT}penguin/ship/review.png`, undefined)).toBeUndefined();
});

test("a root the home folder could not name matches nothing, rather than everything", () => {
  expect(briefPage(`file://${ROOT}penguin/ship/proposal.html`, "")).toBeUndefined();
  expect(briefPage("file:///etc/passwd.html", "")).toBeUndefined();
  expect(briefImage("/etc/passwd", "")).toBeUndefined();
});
