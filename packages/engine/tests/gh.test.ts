import { expect, test } from "bun:test";
import { changedBetween } from "../examples/adapters/gh.ts";

const ME = "mikael";

type Watched = Parameters<typeof changedBetween>[0];

function snapshot(over: Partial<Watched> = {}): Watched {
  return {
    state: "OPEN",
    isDraft: false,
    body: "why this change",
    headRefOid: "abc123",
    url: "https://github.com/mikaelweiss/penguin/pull/7",
    isInMergeQueue: false,
    comments: [],
    reviews: [],
    ...over,
  };
}

test("a review by someone else arrives as reviewed, with its author, state, and body", () => {
  const before = snapshot();
  const after = snapshot({
    reviews: [{ author: { login: "reviewer" }, state: "CHANGES_REQUESTED", body: "  this leaks  " }],
  });
  expect(changedBetween(before, after, ME)).toEqual([
    { kind: "reviewed", author: "reviewer", state: "CHANGES_REQUESTED", body: "this leaks" },
  ]);
});

test("your own approval ends a review and is not fed back as feedback", () => {
  const before = snapshot();
  const after = snapshot({ reviews: [{ author: { login: ME }, state: "APPROVED", body: "" }] });
  expect(changedBetween(before, after, ME)).toEqual([{ kind: "approved" }]);
});

test("reviews already seen do not arrive twice", () => {
  const seen = [{ author: { login: "reviewer" }, state: "COMMENTED", body: "one" }];
  const before = snapshot({ reviews: seen });
  const after = snapshot({
    reviews: [...seen, { author: { login: "reviewer" }, state: "APPROVED", body: "two" }],
  });
  expect(changedBetween(before, after, ME)).toEqual([
    { kind: "reviewed", author: "reviewer", state: "APPROVED", body: "two" },
  ]);
});

test("a comment you wrote yourself is not news", () => {
  const before = snapshot();
  const after = snapshot({
    comments: [{ author: { login: ME }, createdAt: "2026-08-25", body: "posted by the run" }],
  });
  expect(changedBetween(before, after, ME)).toEqual([]);
});

test("a comment someone else wrote still arrives", () => {
  const before = snapshot();
  const after = snapshot({
    comments: [
      { author: { login: ME }, createdAt: "2026-08-25", body: "posted by the run" },
      { author: { login: "reviewer" }, createdAt: "2026-08-26", body: "one question" },
    ],
  });
  expect(changedBetween(before, after, ME)).toEqual([
    {
      kind: "comments",
      comments: [{ author: "reviewer", at: "2026-08-26", body: "one question" }],
    },
  ]);
});

test("a merge closes the pull request and reports the state it landed in", () => {
  const before = snapshot();
  const after = snapshot({ state: "MERGED", headRefOid: "def456" });
  expect(changedBetween(before, after, ME)).toEqual([
    { kind: "closed", state: "MERGED" },
    { kind: "commits" },
  ]);
});
