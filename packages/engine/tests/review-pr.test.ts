import { expect, test } from "bun:test";
import type { Ctx } from "penguin";
import reviewPr from "../examples/workflows/review-pr.ts";

type Change = { kind: string; state?: string };
type Tree = { path: string; name: string };
type Removed = { path: string; force: boolean };

type Options = {
  /** The pull requests the run can read, by number. The reviewed one defaults to open. */
  prs?: Record<string, string>;
  /** The worktrees the repository already holds when the review starts. */
  held?: Tree[];
  /** What the changes watch reports, one per idle wait. A wait past the end is a merge. */
  changes?: Change[];
  /** The worktrees whose removal fails, by path. */
  stuck?: string[];
  /** Listing the worktrees fails outright. */
  blind?: boolean;
  /** What the reviewer returns each round, so a round can block instead of approving. */
  blockers?: { claim: string; where: string }[][];
};

const REVIEWED = "1200";

function harness(options: Options) {
  const shown: string[] = [];
  const removed: Removed[] = [];
  const added: string[] = [];
  const reviewers: string[] = [];
  const posts: string[] = [];
  const prompts: string[] = [];
  /** Which worktrees were alive each time the run parked to wait. */
  const parked: string[][] = [];

  const prs: Record<string, string> = { [REVIEWED]: "OPEN", ...options.prs };
  const stuck = new Set(options.stuck ?? []);
  const blockers = [...(options.blockers ?? [])];
  const queue: Change[] = [...(options.changes ?? [])];
  let held: Tree[] = [...(options.held ?? [])];
  let arrive: ((change: Change) => void) | undefined;
  let sessions = 0;

  const pathOf = (name: string): string => `/worktrees/surestake/${name}`;

  const prOf = (pr: string) => {
    const state = prs[pr];
    if (state === undefined) return null;
    return {
      number: Number(pr),
      state,
      title: `PR ${pr}`,
      body: "what it does",
      url: `https://github.com/o/r/pull/${pr}`,
      isDraft: false,
      isInMergeQueue: false,
      baseRefName: "main",
    };
  };

  const vcs = {
    fetch: () => Promise.resolve(),
    resetHard: () => Promise.resolve(),
    sha: () => Promise.resolve({ sha: "f00d" }),
    worktree: {
      list: () => {
        if (options.blind === true) return Promise.reject(new Error("git would not list"));
        return Promise.resolve(held.map((tree) => ({ ...tree })));
      },
      add: (name: string) => {
        added.push(name);
        const tree = { path: pathOf(name), name };
        held = held.filter((one) => one.name !== name).concat(tree);
        return Promise.resolve({ path: tree.path, existed: false });
      },
      remove: (target: string, opts?: { force?: boolean }) => {
        if (stuck.has(target)) return Promise.reject(new Error(`${target} will not go`));
        removed.push({ path: target, force: opts?.force === true });
        held = held.filter((one) => one.path !== target);
        return Promise.resolve();
      },
    },
  };

  const agent = {
    open: (opts?: { cwd?: string }) => {
      sessions += 1;
      const session = `session-${sessions}`;
      if (opts?.cwd !== undefined) reviewers.push(opts.cwd);
      return Promise.resolve(session);
    },
    stop: () => Promise.resolve(),
    turn: (_session: string, ask: { skill: string; prompt: string }) => {
      prompts.push(ask.prompt);
      const value = { behaviors: [], flows: [], blockers: blockers.shift() ?? [], nonBlockers: [] };
      return { output: (async function* () {})(), value: Promise.resolve(value) };
    },
  };

  const github = {
    pr: {
      get: (pr: string) => Promise.resolve(prOf(pr)),
      comments: () => Promise.resolve([]),
      diff: () => Promise.resolve("+++ b/src/one.ts\n+ added"),
      comment: (_pr: string, body: { body: string }) => {
        posts.push(body.body);
        return Promise.resolve();
      },
      approve: () => Promise.resolve(),
      changes: () => ({
        next: () =>
          new Promise<Change>((resolve) => {
            arrive = resolve;
          }),
      }),
    },
  };

  const jev = {
    review: () => Promise.resolve(null),
    check: () => Promise.resolve([]),
    triage: { pr: () => Promise.resolve({ eyeball: false, reason: "too big to eyeball" }) },
  };

  const view = {
    show: (text: string) => {
      shown.push(text);
      return Promise.resolve();
    },
    ask: () => Promise.resolve("send"),
    status: (_text: string, opts?: { idle?: boolean }) => {
      if (opts?.idle !== true) return Promise.resolve();
      parked.push(held.map((tree) => tree.name));
      const due = queue.shift() ?? { kind: "closed", state: "MERGED" };
      arrive?.(due);
      return Promise.resolve();
    },
  };

  const params = reviewPr.params.parse({ pr: REVIEWED });
  return {
    shown,
    removed,
    added,
    reviewers,
    posts,
    prompts,
    parked,
    held: () => held.map((tree) => tree.name),
    run: () =>
      reviewPr.run({ params, vcs, agent, github, jev, view } as unknown as Ctx<typeof params>),
  };
}

test("the review drops its tree before it parks, and cuts a fresh one when new code lands", async () => {
  const run = harness({ changes: [{ kind: "commits" }] });

  const done = await run.run();

  expect(done.rounds).toBe(2);
  // Neither wait held a checkout: the first parked after round one, the second after round two.
  expect(run.parked).toEqual([[], []]);
  expect(run.added).toEqual([`review-pr-${REVIEWED}`, `review-pr-${REVIEWED}`]);
  // A session cannot outlive the tree it was opened on, so the second round reads from a new one.
  expect(run.reviewers).toHaveLength(2);
});

test("one turn reviews a round, and the second round carries the first round's findings", async () => {
  const run = harness({ changes: [{ kind: "commits" }] });

  await run.run();

  expect(run.prompts).toHaveLength(2);
  expect(run.prompts[0]).toContain("Review this pull request");
  expect(run.prompts[1]).toContain("New code arrived since the last review");
  expect(run.prompts[1]).toContain("### What changes");
});

test("the comment carries what changes, how to test it, and the findings", async () => {
  const run = harness({});

  await run.run();

  expect(run.posts).toHaveLength(1);
  expect(run.posts[0]).toContain("### What changes");
  expect(run.posts[0]).toContain("### How to test");
  expect(run.posts[0]).toContain("### Blockers\n\nnone");
  expect(run.posts[0]).toContain("### Non-blockers\n\nnone");
});

test("the teardown forces, so a tree with a stray edit in it still goes", async () => {
  const run = harness({});

  await run.run();

  expect(run.removed).toHaveLength(1);
  expect(run.removed[0]?.force).toBe(true);
  expect(run.held()).toEqual([]);
});

test("a run that ends on a closed PR leaves no tree behind", async () => {
  const run = harness({ changes: [{ kind: "closed", state: "CLOSED" }] });

  await run.run();

  expect(run.held()).toEqual([]);
});

test("the sweep clears the trees of pull requests that are done", async () => {
  const run = harness({
    prs: { "1072": "MERGED", "1192": "CLOSED" },
    held: [
      { path: "/worktrees/surestake/review-pr-1072", name: "review-pr-1072" },
      { path: "/worktrees/surestake/review-pr-1192", name: "review-pr-1192" },
    ],
  });

  await run.run();

  expect(run.removed.map((one) => one.path)).toContain("/worktrees/surestake/review-pr-1072");
  expect(run.removed.map((one) => one.path)).toContain("/worktrees/surestake/review-pr-1192");
  expect(run.shown.some((line) => line.includes("swept the worktree for PR #1072"))).toBe(true);
});

test("the sweep keeps a tree whose pull request is still open, and every tree that is not a review", async () => {
  const run = harness({
    prs: { "1300": "OPEN" },
    held: [
      { path: "/worktrees/surestake/review-pr-1300", name: "review-pr-1300" },
      { path: "/worktrees/surestake/ss-84-dialogs", name: "ss-84-dialogs" },
      { path: "/worktrees/surestake/review-pr-notes", name: "review-pr-notes" },
    ],
  });

  await run.run();

  expect(run.held()).toContain("review-pr-1300");
  expect(run.held()).toContain("ss-84-dialogs");
  expect(run.held()).toContain("review-pr-notes");
});

test("the sweep leaves the tree the review is about to cut for itself", async () => {
  const run = harness({
    held: [{ path: `/worktrees/surestake/review-pr-${REVIEWED}`, name: `review-pr-${REVIEWED}` }],
  });

  await run.run();

  // The one removal is the review's own teardown at the end, not the sweep taking it first.
  expect(run.removed).toHaveLength(1);
  expect(run.added).toEqual([`review-pr-${REVIEWED}`]);
});

test("a tree the sweep cannot remove does not stop it clearing the rest", async () => {
  const run = harness({
    prs: { "1072": "MERGED", "1098": "MERGED" },
    held: [
      { path: "/worktrees/surestake/review-pr-1072", name: "review-pr-1072" },
      { path: "/worktrees/surestake/review-pr-1098", name: "review-pr-1098" },
    ],
    stuck: ["/worktrees/surestake/review-pr-1072"],
  });

  await run.run();

  expect(run.held()).toContain("review-pr-1072");
  expect(run.held()).not.toContain("review-pr-1098");
  expect(run.shown.some((line) => line.includes("the worktree for PR #1072 stayed"))).toBe(true);
});

test("a repository that will not list its worktrees still gets its review", async () => {
  const run = harness({ blind: true });

  const done = await run.run();

  expect(done.rounds).toBe(1);
  expect(done.posted).toBe(1);
});

test("a round that blocks still drops its tree before it waits for the fix", async () => {
  const run = harness({ blockers: [[{ claim: "the null check is missing", where: "src/one.ts:3" }]] });

  await run.run();

  expect(run.posts).toHaveLength(1);
  expect(run.posts[0]).toContain("- the null check is missing (`src/one.ts:3`)");
  expect(run.parked).toEqual([[]]);
  expect(run.held()).toEqual([]);
});
