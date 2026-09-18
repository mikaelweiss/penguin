import { expect, test } from "bun:test";
import type { Ctx } from "penguin";
import { REVIEWER } from "../examples/helpers/models.ts";
import implement from "../examples/workflows/implement.ts";
import makeWorkflow from "../examples/workflows/make-workflow.ts";
import review from "../examples/workflows/review.ts";
import reviewPr from "../examples/workflows/review-pr.ts";

type Ask = string | { skill: string; prompt?: string };
type Opened = Record<string, unknown>;
type Turn = { session: string; skill: string | undefined; prompt: string };
type Rendered = {
  html: string;
  md: string;
  png: string | null;
  version: number;
  problems: string[];
};
type Where = { name: string; branch?: string };

const PAGE: Rendered = {
  html: "/briefs/review.html",
  md: "/briefs/review.md",
  png: "/briefs/review.png",
  version: 1,
  problems: [],
};

function said(session: string, ask: Ask): Turn {
  if (typeof ask === "string") return { session, skill: undefined, prompt: ask };
  return { session, skill: ask.skill, prompt: ask.prompt ?? "" };
}

function briefs(wheres: Where[], renders: Rendered[], shown: string[], opened: string[]) {
  let rendered = 0;
  return {
    brief: {
      where: (options: Where) => {
        wheres.push(options);
        return Promise.resolve(`/briefs/${options.name}.json`);
      },
      render: () => {
        rendered += 1;
        // A brief that changed is filed as the next version, which is what the renderer reports.
        return Promise.resolve(renders[rendered - 1] ?? { ...PAGE, version: rendered });
      },
      open: (html: string, version: number) => {
        opened.push(`${html}?v=${version}`);
        return Promise.resolve();
      },
    },
    image: (path: string) => {
      shown.push(path);
      return Promise.resolve();
    },
  };
}

function harness(values: unknown[], answers: string[] = []) {
  const opens: Opened[] = [];
  const turns: Turn[] = [];
  const wheres: Where[] = [];
  const shown: string[] = [];
  const opened: string[] = [];
  const pages = briefs(wheres, [], shown, opened);
  const agent = {
    open: (options?: Opened) => {
      opens.push(options ?? {});
      return Promise.resolve(`session-${opens.length}`);
    },
    turn: (session: string, ask: Ask) => {
      turns.push(said(session, ask));
      return {
        output: (async function* () {})(),
        value: Promise.resolve(values[turns.length - 1] ?? {}),
      };
    },
  };
  const view = {
    show: () => Promise.resolve(),
    act: () => Promise.resolve(),
    image: pages.image,
    ask: () => Promise.resolve(answers.shift() ?? "approve"),
  };
  const gates = { run: () => Promise.resolve({ green: true, report: "bun test: pass" }) };
  const vcs = { status: () => Promise.resolve({ files: [{ status: "M", path: "src/edited.ts" }] }) };
  const ctx = { agent, brief: pages.brief, gates, vcs, view } as unknown as Ctx<unknown>;

  /** The options the session that ran this skill was opened with. */
  const openedFor = (skill: string): Opened | undefined => {
    const session = turns.find((turn) => turn.skill === skill)?.session;
    const index = opens.findIndex((_, at) => `session-${at + 1}` === session);
    return index === -1 ? undefined : opens[index];
  };
  /** The prompt the turn on this skill was given. */
  const promptFor = (skill: string): string =>
    turns.find((turn) => turn.skill === skill)?.prompt ?? "";
  return { opens, turns, wheres, shown, opened, ctx, openedFor, promptFor };
}

const APPROVED = { verdict: "approved", blocking: "", notes: "" };

test("review opens its session on the reviewing adapter", async () => {
  const bench = harness([APPROVED]);

  await review.run({
    ...bench.ctx,
    params: { acceptance: "it works", blocking: "", baseline: "", base: "" },
  } as never);

  expect(bench.opens).toEqual([{ adapter: REVIEWER }]);
});

test("review writes its brief on the session that judged, and shows the page", async () => {
  const bench = harness([APPROVED]);

  await review.run({
    ...bench.ctx,
    params: { acceptance: "it works", blocking: "", baseline: "", base: "" },
  } as never);

  expect(bench.openedFor("brief")).toEqual({ adapter: REVIEWER });
  expect(bench.wheres).toEqual([{ name: "review", branch: undefined }]);
  expect(bench.shown).toEqual(["/briefs/review.png"]);
});

test("implement reviews on the reviewing adapter and writes on the configured one", async () => {
  const scouted = { files: ["src/widget.ts"], found: "", missing: "" };
  const bench = harness([scouted, {}, APPROVED]);

  await implement.run({
    ...bench.ctx,
    params: { task: "add a toggle", rounds: 1, baseline: "", base: "" },
  } as never);

  expect(bench.openedFor("review")?.["adapter"]).toBe(REVIEWER);
  expect(bench.openedFor("implement")).not.toHaveProperty("adapter");
  // The scout opens first, on a plain prompt rather than a skill.
  expect(bench.opens[0]).not.toHaveProperty("adapter");
});

test("the implement reviewer keeps the window bound it shares with the implementer", async () => {
  const scouted = { files: ["src/widget.ts"], found: "", missing: "" };
  const bench = harness([scouted, {}, APPROVED]);

  await implement.run({
    ...bench.ctx,
    params: { task: "add a toggle", rounds: 1, baseline: "", base: "" },
  } as never);

  expect(bench.openedFor("review")).toEqual({ adapter: REVIEWER, autocompact: "200000" });
});

test("the implement brief covers the branch since its base, not the task that wrote it", async () => {
  const scouted = { files: ["src/widget.ts"], found: "", missing: "" };
  const bench = harness([scouted, {}, APPROVED]);

  await implement.run({
    ...bench.ctx,
    params: { task: "add a toggle", rounds: 1, baseline: "", base: "origin/main" },
  } as never);

  const written = bench.promptFor("brief");
  expect(written).toContain("Every change on this branch");
  expect(written).toContain("git diff origin/main..HEAD");
});

test("make-workflow reviews the draft on the reviewing adapter, and writes it on neither", async () => {
  const bench = harness([
    { design: "the design" },
    { file: "~/.penguin/workflows/thing.ts", name: "thing" },
    { verdict: "approved", findings: "" },
  ]);

  await makeWorkflow.run({
    ...bench.ctx,
    params: { idea: "a workflow", scope: "home", rounds: 1 },
  } as never);

  expect(bench.openedFor("review-workflow")).toEqual({ adapter: REVIEWER });
  expect(bench.openedFor("write-workflow")).toEqual({});
  expect(bench.openedFor("design-workflow")).toEqual({});
});

const CLEAN = { behaviors: [], flows: [], blockers: [], nonBlockers: [] };

/** review-pr to its approved rounds: one reviewer turn each. Jev triages it into the review. */
function pullRequest(
  options: { judged?: unknown; rounds?: number; overtaken?: boolean; weak?: string[] } = {},
) {
  const opens: Opened[] = [];
  const turns: Turn[] = [];
  const wheres: Where[] = [];
  const shown: string[] = [];
  const opened: string[] = [];
  const events: string[] = [];
  const comments: ({ body: string } | { bodyFile: string })[] = [];
  const rounds = options.rounds ?? 1;
  // The watch idles until the pull request moves, so what a round posts is what moves it on.
  const queued: unknown[] = [];
  let waiting: ((change: unknown) => void) | undefined;
  const push = (change: unknown): void => {
    const settle = waiting;
    waiting = undefined;
    if (settle === undefined) queued.push(change);
    else settle(change);
  };
  const next = (): Promise<unknown> =>
    queued.length > 0
      ? Promise.resolve(queued.shift())
      : new Promise((settle) => {
          waiting = settle;
        });
  // An overtaken round's first turn hangs until a push stops it, and the tree moves under it.
  if (options.overtaken === true) queued.push({ kind: "commits" });
  let stopped: (() => void) | undefined;
  let shas = 0;
  let trees = 0;
  const pages = briefs(wheres, [], shown, opened);
  const values: unknown[] = [];
  if (options.overtaken === true) values.push(CLEAN);
  for (let round = 0; round < rounds; round++) values.push(options.judged ?? CLEAN);
  const jev = {
    review: () => Promise.resolve(null),
    check: (input: { claims: { claim: string; where: string }[] }) =>
      Promise.resolve(
        input.claims.map((one) => {
          const weak = (options.weak ?? []).includes(one.where);
          return { ...one, read: true, confidence: weak ? 0.9 : 0.1, verdict: weak ? "unsupported" : "supported" };
        }),
      ),
    triage: { pr: () => Promise.resolve({ eyeball: false, reason: "one file" }) },
  };
  const agent = {
    open: (options?: Opened) => {
      opens.push(options ?? {});
      return Promise.resolve(`session-${opens.length}`);
    },
    turn: (session: string, ask: Ask) => {
      turns.push(said(session, ask));
      const output = (async function* () {})();
      if (options.overtaken === true && turns.length === 1) {
        const value = new Promise<never>((_, fail) => {
          stopped = () => fail(new Error("the turn was stopped"));
        });
        return { output, value };
      }
      return { output, value: Promise.resolve(values[turns.length - 1] ?? {}) };
    },
    stop: () => {
      stopped?.();
      stopped = undefined;
      return Promise.resolve();
    },
  };
  const pr = {
    number: 7,
    title: "add a toggle",
    url: "https://github.test/pr/7",
    body: "the body",
    state: "OPEN",
    baseRefName: "main",
    isDraft: false,
    isInMergeQueue: false,
  };
  const github = {
    pr: {
      get: () => Promise.resolve(pr),
      comments: () => Promise.resolve([]),
      diff: () => Promise.resolve("+++ b/src/widget.ts\n+const on = true;"),
      changes: () => ({ next }),
      comment: (_pr: string, body: { body: string } | { bodyFile: string }) => {
        events.push("comment");
        comments.push(body);
        push(
          comments.length < rounds
            ? { kind: "commits" }
            : { kind: "closed", state: "MERGED" },
        );
        return Promise.resolve();
      },
      approve: () => Promise.resolve(),
    },
  };
  const vcs = {
    fetch: () => Promise.resolve(),
    resetHard: () => Promise.resolve(),
    sha: () => {
      shas += 1;
      return Promise.resolve({ sha: options.overtaken === true && shas > 1 ? "def" : "abc" });
    },
    worktree: {
      add: () => {
        trees += 1;
        return Promise.resolve({ existed: false, path: "/tmp/trees/review-pr-7" });
      },
      remove: () => Promise.resolve(),
    },
  };
  const view = {
    show: () => Promise.resolve(),
    act: () => Promise.resolve(),
    status: () => Promise.resolve(),
    image: pages.image,
    ask: () => {
      events.push("ask");
      return Promise.resolve("send");
    },
  };
  const ctx = {
    agent,
    brief: pages.brief,
    github,
    jev,
    vcs,
    view,
    params: { pr: "7" },
  } as unknown as Ctx<{ pr: string }>;
  const openedFor = (skill: string): Opened | undefined => {
    const session = turns.find((turn) => turn.skill === skill)?.session;
    const index = opens.findIndex((_, at) => `session-${at + 1}` === session);
    return index === -1 ? undefined : opens[index];
  };
  return {
    opens,
    turns,
    wheres,
    shown,
    opened,
    events,
    comments,
    openedFor,
    trees: () => trees,
    run: () => reviewPr.run(ctx as never),
  };
}

test("review-pr reviews on the configured adapter, and opens no session to triage", async () => {
  const bench = pullRequest();

  const done = await bench.run();

  expect(done).toEqual({ rounds: 1, posted: 1 });
  expect(bench.openedFor("review-pr")).not.toHaveProperty("adapter");
  expect(bench.turns.map((turn) => turn.skill)).toEqual(["review-pr"]);
});

test("the reviewer opens on the worktree with the window its rounds are built on", async () => {
  const bench = pullRequest();

  await bench.run();

  expect(bench.openedFor("review-pr")).toEqual({
    cwd: "/tmp/trees/review-pr-7",
    autocompact: "200000",
  });
});

test("the comment carries the findings, and no page is rendered for them", async () => {
  const bench = pullRequest();

  await bench.run();

  expect(bench.comments).toEqual([{ body: expect.stringContaining("### Blockers") }]);
  expect(bench.wheres).toEqual([]);
  expect(bench.shown).toEqual([]);
});

test("blockers still wait at the send gate before the findings are posted", async () => {
  const bench = pullRequest({
    judged: { ...CLEAN, blockers: [{ claim: "the toggle has no test", where: "src/widget.ts:1" }] },
  });

  await bench.run();

  expect(bench.events).toEqual(["ask", "comment"]);
  expect(bench.comments).toEqual([{ body: expect.stringContaining("the toggle has no test (`src/widget.ts:1`)") }]);
});

test("a finding the code at its line does not carry is demoted or dropped before it posts", async () => {
  const bench = pullRequest({
    judged: {
      ...CLEAN,
      blockers: [{ claim: "the toggle has no test", where: "src/widget.ts:1" }],
      nonBlockers: [
        { claim: "the label is stale", where: "src/widget.ts:2" },
        { claim: "the name is unclear", where: "src/widget.ts:3" },
      ],
    },
    weak: ["src/widget.ts:1", "src/widget.ts:2"],
  });

  await bench.run();

  expect(bench.events).toEqual(["comment"]);
  const said = bench.comments[0] as { body: string };
  expect(said.body).toContain("the toggle has no test. The code at this line does not show this");
  expect(said.body).toContain("the name is unclear");
  expect(said.body).not.toContain("the label is stale");
});

test("a push mid-round starts over on a fresh reviewer and the same worktree", async () => {
  const bench = pullRequest({ overtaken: true });

  const done = await bench.run();

  expect(done).toEqual({ rounds: 2, posted: 1 });
  expect(bench.turns.map((turn) => turn.session)).toEqual(["session-1", "session-2"]);
  expect(bench.trees()).toBe(1);
});

test("a push after the post opens a second round on a fresh reviewer", async () => {
  const bench = pullRequest({ rounds: 2 });

  const done = await bench.run();

  expect(done).toEqual({ rounds: 2, posted: 2 });
  expect(bench.turns.map((turn) => turn.session)).toEqual(["session-1", "session-2"]);
});

