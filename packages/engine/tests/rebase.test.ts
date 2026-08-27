import { expect, test } from "bun:test";
import type { Ctx } from "penguin";
import rebase from "../examples/workflows/rebase.ts";

const LOCK = "error: cannot lock ref 'refs/remotes/origin/main': is at 9a85720 but expected 9cac28b";

type Options = {
  /** Whether each fetch in turn succeeds. A fetch past the end succeeds. */
  fetches?: boolean[];
  /** What the person types at each gate. A gate past the end is answered with abort. */
  answers?: string[];
  /** The worktree starts with no branch, and the first gate is what puts one back. */
  detached?: boolean;
  /** The worktree starts holding the rebase of a run that died. */
  pending?: boolean;
};

function harness(options: Options) {
  const asked: string[] = [];
  const shown: string[] = [];
  let fetches = 0;
  let aborts = 0;
  let detached = options.detached ?? false;
  let pending = options.pending ?? false;

  const rebasing = { ok: true, conflicted: false, files: [], reason: "" };
  const vcs = {
    head: () => Promise.resolve({ ok: true, branch: "feature", sha: "f00d", detached }),
    dirty: () => Promise.resolve({ ok: true, dirty: false, reason: "" }),
    sha: () => Promise.resolve({ ok: true, sha: "ba5e", reason: "" }),
    fetch: () => {
      const ok = options.fetches?.[fetches] ?? true;
      fetches += 1;
      return Promise.resolve({ ok, reason: ok ? "" : LOCK });
    },
    rebase: {
      onto: () => Promise.resolve(rebasing),
      continue: () => Promise.resolve(rebasing),
      pending: () => Promise.resolve(pending),
      abort: () => {
        aborts += 1;
        pending = false;
        return Promise.resolve({ ok: true, reason: "" });
      },
    },
  };

  const agent = {
    open: () => Promise.resolve("session"),
    turn: () => {
      throw new Error("the rebase asked an agent for something that is not a conflict");
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
      // The person is the one who can put the worktree back on a branch.
      detached = false;
      return Promise.resolve(options.answers?.[asked.length - 1] ?? "abort");
    },
  };

  const params = rebase.params.parse({});
  return {
    asked,
    shown,
    fetches: () => fetches,
    aborts: () => aborts,
    run: () => rebase.run({ params, vcs, agent, view } as unknown as Ctx<typeof params>),
  };
}

test("a fetch that fails waits for the person, then runs again", async () => {
  const run = harness({ fetches: [false, true], answers: ["continue"] });

  const done = await run.run();

  expect(done.rebased).toBe(true);
  expect(run.fetches()).toBe(2);
  expect(run.asked).toHaveLength(1);
  expect(run.asked[0]).toContain(LOCK);
});

test("only the person saying abort ends the rebase", async () => {
  const run = harness({ fetches: [false, false, false], answers: ["abort"] });

  const done = await run.run();

  expect(done.rebased).toBe(false);
  expect(done.reason).toBe("the user dropped the rebase");
  expect(run.fetches()).toBe(1);
});

test("a worktree with no branch waits for the person instead of ending the run", async () => {
  const run = harness({ detached: true, answers: ["continue"] });

  const done = await run.run();

  expect(done.rebased).toBe(true);
  expect(run.asked).toHaveLength(1);
  expect(run.asked[0]).toContain("detached");
});

test("the rebase a dead run left open is dropped without asking anyone", async () => {
  const run = harness({ pending: true });

  const done = await run.run();

  expect(done.rebased).toBe(true);
  expect(run.aborts()).toBe(1);
  expect(run.asked).toHaveLength(0);
  expect(run.shown.some((line) => line.includes("unfinished rebase"))).toBe(true);
});
