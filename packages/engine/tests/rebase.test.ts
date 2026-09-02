import { expect, test } from "bun:test";
import type { Ctx } from "penguin";
import rebase from "../examples/workflows/rebase.ts";

type Options = {
  /** How many rebase passes stop on a conflict before one runs clean. */
  conflicts?: number;
  /** What the person types at each gate. A gate past the end is answered with abort. */
  answers?: string[];
  /** The worktree starts holding the rebase of a run that died. */
  pending?: boolean;
};

function harness(options: Options) {
  const asked: string[] = [];
  const shown: string[] = [];
  const prompts: string[] = [];
  let fetches = 0;
  let aborts = 0;
  let turns = 0;
  let conflicts = options.conflicts ?? 0;
  let pending = options.pending ?? false;

  const rebasing = () => {
    if (conflicts === 0) return Promise.resolve({ conflicted: false, files: [] });
    conflicts -= 1;
    return Promise.resolve({ conflicted: true, files: ["same.txt"] });
  };
  const vcs = {
    head: () => Promise.resolve({ branch: "feature", sha: "f00d", detached: false }),
    dirty: () => Promise.resolve({ dirty: false }),
    sha: () => Promise.resolve({ sha: "ba5e" }),
    fetch: () => {
      fetches += 1;
      return Promise.resolve();
    },
    log: () => Promise.resolve({ text: "commit f00d" }),
    read: (file: string) =>
      Promise.resolve({ there: true, text: `<<<<<<< HEAD in ${file}`, truncated: false }),
    rebase: {
      onto: rebasing,
      continue: () => Promise.resolve({ conflicted: false, files: [] }),
      pending: () => Promise.resolve(pending),
      patch: () => Promise.resolve({ text: "the patch", truncated: false }),
      conflicts: () => Promise.resolve({ files: ["same.txt"] }),
      abort: () => {
        aborts += 1;
        pending = false;
        return Promise.resolve();
      },
    },
  };

  const agent = {
    open: () => Promise.resolve("session"),
    turn: (_session: string, ask: { prompt: string }) => {
      turns += 1;
      prompts.push(ask.prompt);
      return {
        output: (async function* () {})(),
        value: Promise.resolve({ resolved: true, notes: "" }),
      };
    },
  };

  const view = {
    show: (text: string) => {
      shown.push(text);
      return Promise.resolve();
    },
    act: () => Promise.resolve(),
    ask: (text: string) => {
      asked.push(text);
      return Promise.resolve(options.answers?.[asked.length - 1] ?? "abort");
    },
  };

  const params = rebase.params.parse({});
  return {
    asked,
    shown,
    prompts,
    fetches: () => fetches,
    aborts: () => aborts,
    turns: () => turns,
    run: () => rebase.run({ params, vcs, agent, view } as unknown as Ctx<typeof params>),
  };
}

test("a clean pass rebases without asking anyone", async () => {
  const run = harness({});

  const done = await run.run();

  expect(done.rebased).toBe(true);
  expect(done.sha).toBe("f00d");
  expect(run.asked).toHaveLength(0);
  expect(run.fetches()).toBe(1);
});

test("a conflicted pass goes to the resolver, then a fresh pass confirms the base held still", async () => {
  const run = harness({ conflicts: 1 });

  const done = await run.run();

  expect(done.rebased).toBe(true);
  expect(run.turns()).toBe(1);
  // The conflicted pass and the clean pass that follows it.
  expect(run.fetches()).toBe(2);
  expect(run.asked).toHaveLength(0);
});

test("the rebase a dead run left open is dropped without asking anyone", async () => {
  const run = harness({ pending: true });

  const done = await run.run();

  expect(done.rebased).toBe(true);
  expect(run.aborts()).toBe(1);
  expect(run.asked).toHaveLength(0);
  expect(run.shown.some((line) => line.includes("unfinished rebase"))).toBe(true);
});

test("the resolver is handed the tree: the landed commit, the patch, and every conflicted file", async () => {
  const run = harness({ conflicts: 1 });

  await run.run();

  const prompt = run.prompts[0] ?? "";
  expect(prompt).toContain("# HEAD\n\ncommit f00d");
  expect(prompt).toContain("# Replaying\n\nthe patch");
  expect(prompt).toContain("## same.txt\n\n<<<<<<< HEAD in same.txt");
});
