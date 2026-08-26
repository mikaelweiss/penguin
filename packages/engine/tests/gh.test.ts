import { expect, test } from "bun:test";
import type { CommandResult, Host } from "../src/core/adapter.ts";
import definition, { changedBetween, movesOf } from "../examples/adapters/gh.ts";

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

/** A poll that hands back one step per read. A read past the last step never settles. */
function polling(steps: (string | Error)[]): {
  read: () => Promise<string>;
  rest: () => Promise<void>;
  reads: () => number;
  rests: () => number;
} {
  let taken = 0;
  let rested = 0;
  return {
    read: () => {
      const step = steps[taken++];
      if (step === undefined) return new Promise<string>(() => {});
      if (step instanceof Error) return Promise.reject(step);
      return Promise.resolve(step);
    },
    rest: () => {
      rested += 1;
      return Promise.resolve();
    },
    reads: () => taken,
    rests: () => rested,
  };
}

test("the first poll is only a baseline, and the head it settles on is not a move", async () => {
  const poll = polling(["abc", "abc", "def"]);
  const moves = movesOf(poll.read, poll.rest);
  expect(await moves.next()).toEqual({ sha: "def" });
  expect(poll.reads()).toBe(3);
  expect(poll.rests()).toBe(2);
});

test("a head already reported is never reported twice", async () => {
  const poll = polling(["abc", "def", "def", "ghi"]);
  const moves = movesOf(poll.read, poll.rest);
  expect(await moves.next()).toEqual({ sha: "def" });
  expect(await moves.next()).toEqual({ sha: "ghi" });
  expect(poll.reads()).toBe(4);
});

test("a poll the branch cannot be read on reports nothing and keeps watching", async () => {
  const poll = polling([new Error("origin names no head for main"), "abc", "def"]);
  const moves = movesOf(poll.read, poll.rest);
  expect(await moves.next()).toEqual({ sha: "def" });
  expect(poll.reads()).toBe(3);
});

/** A gh that answers one canned result and keeps what it was asked. */
function fakeGh(reply: CommandResult): { gh: ReturnType<typeof definition.build>; args: string[][] } {
  const args: string[][] = [];
  const host: Host = {
    cwd: "/",
    home: "/tmp",
    state: "/tmp",
    run: { id: "test", dir: "/tmp" },
    config: () => undefined,
    secret: async () => undefined,
    note: () => {},
    skill: () => {
      throw new Error("no skills installed");
    },
    shell: async () => ({ code: 0, stdout: "", stderr: "" }),
    exec: async (argv) => {
      args.push(argv);
      return reply;
    },
  };
  return { gh: definition.build(host), args };
}

test("a branch with no pull request open on it comes back empty, not failed", async () => {
  const { gh } = fakeGh({ code: 0, stdout: "[]\n", stderr: "" });
  expect(await gh.pr.of("feature")).toEqual({ ok: true, prs: [], reason: "" });
});

test("the base an open pull request lands on comes back with it", async () => {
  const listed = [{ number: 7, baseRefName: "stack-below", url: "https://github.com/o/r/pull/7" }];
  const { gh, args } = fakeGh({ code: 0, stdout: JSON.stringify(listed), stderr: "" });
  expect(await gh.pr.of("feature")).toEqual({ ok: true, prs: listed, reason: "" });
  expect(args[0]).toContain("feature");
});
