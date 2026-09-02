import { expect, test } from "bun:test";
import type { Ctx } from "penguin";
import { REVIEWER } from "../examples/helpers/models.ts";
import implement from "../examples/workflows/implement.ts";
import makeWorkflow from "../examples/workflows/make-workflow.ts";
import review from "../examples/workflows/review.ts";
import reviewPr from "../examples/workflows/review-pr.ts";

type Ask = string | { skill: string; prompt?: string };
type Opened = Record<string, unknown>;
type Turn = { session: string; skill: string | undefined };

function harness(values: unknown[], answers: string[] = []) {
  const opens: Opened[] = [];
  const turns: Turn[] = [];
  const agent = {
    open: (options?: Opened) => {
      opens.push(options ?? {});
      return Promise.resolve(`session-${opens.length}`);
    },
    turn: (session: string, ask: Ask) => {
      turns.push({ session, skill: typeof ask === "string" ? undefined : ask.skill });
      return {
        output: (async function* () {})(),
        value: Promise.resolve(values[turns.length - 1] ?? {}),
      };
    },
  };
  const view = {
    show: () => Promise.resolve(),
    act: () => Promise.resolve(),
    ask: () => Promise.resolve(answers.shift() ?? "approve"),
  };
  const gates = { run: () => Promise.resolve({ green: true, report: "bun test: pass" }) };
  const vcs = { status: () => Promise.resolve({ files: [{ status: "M", path: "src/edited.ts" }] }) };
  const ctx = { agent, gates, vcs, view } as unknown as Ctx<unknown>;

  /** The options the session that ran this skill was opened with. */
  const openedFor = (skill: string): Opened | undefined => {
    const session = turns.find((turn) => turn.skill === skill)?.session;
    const index = opens.findIndex((_, at) => `session-${at + 1}` === session);
    return index === -1 ? undefined : opens[index];
  };
  return { opens, turns, ctx, openedFor };
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

/** review-pr to one approved round: the triage, the gather, and the judgment, and nothing else. */
function pullRequest() {
  const opens: Opened[] = [];
  const turns: Turn[] = [];
  const values: unknown[] = [{ eyeball: false, reason: "one file" }, DOSSIER, CLEAN];
  const agent = {
    open: (options?: Opened) => {
      opens.push(options ?? {});
      return Promise.resolve(`session-${opens.length}`);
    },
    turn: (session: string, ask: Ask) => {
      turns.push({ session, skill: typeof ask === "string" ? undefined : ask.skill });
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
      changes: () => ({ next: () => new Promise<never>(() => {}) }),
      comment: () => Promise.resolve(),
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
    ask: () => Promise.resolve("send"),
  };
  const ctx = { agent, github, vcs, view, params: { pr: "7" } } as unknown as Ctx<{ pr: string }>;
  const openedFor = (skill: string): Opened | undefined => {
    const session = turns.find((turn) => turn.skill === skill)?.session;
    const index = opens.findIndex((_, at) => `session-${at + 1}` === session);
    return index === -1 ? undefined : opens[index];
  };
  return { opens, turns, openedFor, run: () => reviewPr.run(ctx as never) };
}

test("review-pr gathers on the reviewing adapter, and triages on the configured one", async () => {
  const bench = pullRequest();

  const done = await bench.run();

  expect(done).toEqual({ rounds: 1, posted: 1 });
  expect(bench.openedFor("review-gather")?.["adapter"]).toBe(REVIEWER);
  expect(bench.openedFor("triage-pr")).not.toHaveProperty("adapter");
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
    adapter: REVIEWER,
    model: "small",
    cwd: "/tmp/trees/review-pr-7",
    autocompact: "200000",
  });
});
