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
const REFUSED: Rendered = { html: "", md: "", png: null, version: 0, problems: ["title: missing"] };

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

const DOSSIER = { files: [], flows: [], state: [], facts: [] };
const CLEAN = { blockers: [], nonBlockers: [], questions: [] };

/** review-pr to its approved rounds: each round's gather, judgment, and page. Jev triages it into the review. */
function pullRequest(options: { judged?: unknown; renders?: Rendered[]; rounds?: number } = {}) {
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
  const pages = briefs(wheres, options.renders ?? [], shown, opened);
  const values: unknown[] = [];
  for (let round = 0; round < rounds; round++) values.push(DOSSIER, options.judged ?? CLEAN, {});
  const jev = {
    review: () => Promise.resolve(null),
    triage: { pr: () => Promise.resolve({ eyeball: false, reason: "one file" }) },
  };
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
    stop: () => Promise.resolve(),
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
    sha: () => Promise.resolve({ sha: "abc" }),
    worktree: {
      add: () => Promise.resolve({ existed: false, path: "/tmp/trees/review-pr-7" }),
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
    run: () => reviewPr.run(ctx as never),
  };
}

test("review-pr gathers on the configured adapter, and opens no session to triage", async () => {
  const bench = pullRequest();

  const done = await bench.run();

  expect(done).toEqual({ rounds: 1, posted: 1 });
  expect(bench.openedFor("review-gather")).not.toHaveProperty("adapter");
  expect(bench.turns.map((turn) => turn.skill)).not.toContain("triage-pr");
});

test("the review-pr judge stays where its empty tool list is honoured", async () => {
  const bench = pullRequest();

  await bench.run();

  expect(bench.openedFor("review-judge")).toEqual({ tools: [], settings: [] });
});

test("the gatherer keeps the worktree and the window its rounds are built on", async () => {
  const bench = pullRequest();

  await bench.run();

  expect(bench.openedFor("review-gather")).toEqual({
    model: "small",
    cwd: "/tmp/trees/review-pr-7",
    autocompact: "200000",
  });
});

test("the brief is written where the tree is, and scoped to the pull request", async () => {
  const bench = pullRequest();

  await bench.run();

  expect(bench.wheres).toEqual([{ name: "review", branch: "pr-7" }]);
  expect(bench.openedFor("brief")).toEqual({
    model: "small",
    cwd: "/tmp/trees/review-pr-7",
    autocompact: "200000",
  });
});

test("the comment carries the page the person reads, and the shot goes up after it", async () => {
  const bench = pullRequest();

  await bench.run();

  expect(bench.comments).toEqual([{ bodyFile: "/briefs/review.md" }]);
  expect(bench.shown).toEqual(["/briefs/review.png"]);
});

test("blockers still wait at the send gate before the page is posted", async () => {
  const bench = pullRequest({
    judged: { blockers: ["the toggle has no test"], nonBlockers: [], questions: [] },
  });

  await bench.run();

  expect(bench.events).toEqual(["ask", "comment"]);
  expect(bench.comments).toEqual([{ bodyFile: "/briefs/review.md" }]);
});

test("a second round's page is a new version, so the tab the person left open reloads", async () => {
  const bench = pullRequest({ rounds: 2 });

  const done = await bench.run();

  expect(done).toEqual({ rounds: 2, posted: 2 });
  expect(bench.opened).toEqual(["/briefs/review.html?v=1", "/briefs/review.html?v=2"]);
});

test("a brief that would not render leaves the report as the comment", async () => {
  const bench = pullRequest({ renders: [REFUSED, REFUSED, REFUSED] });

  await bench.run();

  const said = bench.comments[0] as { body: string };
  expect(said.body).toContain("### Blockers");
  expect(bench.shown).toEqual([]);
});
