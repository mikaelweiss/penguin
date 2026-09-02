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

/** A gh that answers canned results in order and keeps what it was asked. */
function fakeGh(replies: CommandResult | CommandResult[]): {
  gh: ReturnType<typeof definition.build>;
  args: string[][];
  opened: string[];
} {
  const canned = Array.isArray(replies) ? replies : [replies];
  const args: string[][] = [];
  const opened: string[] = [];
  const host: Host = {
    cwd: "/",
    home: "/tmp",
    state: "/tmp",
    run: { id: "test", dir: "/tmp" },
    config: () => undefined,
    secret: async () => undefined,
    note: () => {},
    open: (url) => opened.push(url),
    skill: () => {
      throw new Error("no skills installed");
    },
    spawn: () => {
      throw new Error("no spawn in this test");
    },
    shell: async () => ({ code: 0, stdout: "", stderr: "" }),
    exec: async (argv) => {
      args.push(argv);
      return canned[Math.min(args.length, canned.length) - 1] ?? { code: 0, stdout: "", stderr: "" };
    },
  };
  return { gh: definition.build(host), args, opened };
}

const PR_URL = "https://github.com/o/r/pull/9";

function prJson(over: Record<string, unknown> = {}): CommandResult {
  return {
    code: 0,
    stdout: JSON.stringify({
      number: 9,
      title: "t",
      body: "b",
      state: "OPEN",
      isDraft: false,
      headRefOid: "abc",
      baseRefName: "main",
      url: PR_URL,
      ...over,
    }),
    stderr: "",
  };
}

const NO_QUEUE: CommandResult = { code: 0, stdout: "false\n", stderr: "" };
const NONE: CommandResult = { code: 0, stdout: "[]\n", stderr: "" };

test("a branch with no pull request open on it comes back empty, not failed", async () => {
  const { gh } = fakeGh(NONE);
  expect(await gh.pr.of("feature")).toEqual([]);
});

test("the base an open pull request lands on comes back with it", async () => {
  const listed = [{ number: 7, baseRefName: "stack-below", url: "https://github.com/o/r/pull/7" }];
  const { gh, args } = fakeGh({ code: 0, stdout: JSON.stringify(listed), stderr: "" });
  expect(await gh.pr.of("feature")).toEqual(listed);
  expect(args[0]).toContain("feature");
});

test("ensure opens a pull request when the branch has neither an open nor a merged one", async () => {
  const { gh, opened } = fakeGh([
    NONE,
    NONE,
    { code: 0, stdout: `${PR_URL}\n`, stderr: "" },
    prJson(),
    NO_QUEUE,
  ]);
  const made = await gh.pr.ensure({ head: "feature", base: "main", title: "t", body: "b" });
  expect(made.landed).toBe(false);
  expect(made.created).toBe(true);
  expect(made.pr?.number).toBe(9);
  expect(opened).toEqual([PR_URL]);
});

test("ensure hands back the open pull request as it stands, base and all", async () => {
  const listed = [{ number: 9, baseRefName: "stack-below", url: PR_URL }];
  const { gh } = fakeGh([
    { code: 0, stdout: JSON.stringify(listed), stderr: "" },
    prJson({ baseRefName: "stack-below" }),
    NO_QUEUE,
  ]);
  const made = await gh.pr.ensure({ head: "feature", base: "main", title: "t", body: "b" });
  expect(made.landed).toBe(false);
  expect(made.created).toBe(false);
  expect(made.pr?.baseRefName).toBe("stack-below");
});

test("ensure answers landed for a branch whose pull request already merged", async () => {
  const listed = [{ number: 9, baseRefName: "main", url: PR_URL }];
  const { gh } = fakeGh([
    NONE,
    { code: 0, stdout: JSON.stringify(listed), stderr: "" },
    prJson({ state: "MERGED" }),
    NO_QUEUE,
  ]);
  const made = await gh.pr.ensure({ head: "feature", base: "main", title: "t", body: "b" });
  expect(made.landed).toBe(true);
  expect(made.pr?.state).toBe("MERGED");
});

test("ensure answers landed for a branch with nothing over the base", async () => {
  const { gh } = fakeGh([
    NONE,
    NONE,
    {
      code: 1,
      stdout: "",
      stderr: "GraphQL: No commits between main and feature (createPullRequest)",
    },
  ]);
  const made = await gh.pr.ensure({ head: "feature", base: "main", title: "t", body: "b" });
  expect(made).toEqual({ landed: true, pr: null, created: false });
});

test("only the threads still open come back, with the id a reply goes on", async () => {
  const nodes = [
    {
      id: "T_one",
      isResolved: false,
      path: "src/a.ts",
      line: 12,
      comments: { nodes: [{ body: "  this leaks  ", author: { login: "reviewer" } }] },
    },
    {
      id: "T_two",
      isResolved: true,
      path: "src/b.ts",
      line: 3,
      comments: { nodes: [{ body: "settled", author: { login: "reviewer" } }] },
    },
  ];
  const { gh, args } = fakeGh({ code: 0, stdout: JSON.stringify(nodes), stderr: "" });
  expect(await gh.pr.threads(PR_URL)).toEqual([
    {
      id: "T_one",
      path: "src/a.ts",
      line: 12,
      comments: [{ author: "reviewer", body: "this leaks" }],
    },
  ]);
  expect(args[0]).toContain("graphql");
});

test("a thread whose line is gone from the diff still comes back, with no line", async () => {
  const nodes = [
    { id: "T_one", isResolved: false, path: "src/a.ts", line: null, comments: { nodes: [] } },
  ];
  const { gh } = fakeGh({ code: 0, stdout: JSON.stringify(nodes), stderr: "" });
  expect((await gh.pr.threads(PR_URL))[0]?.line).toBe(null);
});

test("the merged titles come back in the order gh lists them", async () => {
  const listed = [{ title: "feat: one" }, { title: "fix: two" }];
  const { gh, args } = fakeGh({ code: 0, stdout: JSON.stringify(listed), stderr: "" });
  expect(await gh.pr.titles(20)).toEqual(["feat: one", "fix: two"]);
  expect(args[0]).toContain("merged");
  expect(args[0]).toContain("20");
});

test("a reply carries the thread and the body to the mutation", async () => {
  const { gh, args } = fakeGh({ code: 0, stdout: "{}", stderr: "" });
  await gh.pr.reply("T_one", "the code already covers this");
  expect(args[0]).toContain("thread=T_one");
  expect(args[0]).toContain("body=the code already covers this");
});

test("a graphql call that fails is a fault, not an empty list", async () => {
  const { gh } = fakeGh({ code: 1, stdout: "", stderr: "gh: not found" });
  expect(gh.pr.threads(PR_URL)).rejects.toThrow("gh: not found");
});
