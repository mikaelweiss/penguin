import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Ctx } from "penguin";
import openPr from "../examples/workflows/open-pr.ts";

const RUN = Symbol.for("penguin.run");

type Ensured = { head: string; base: string; title: string; body: string };
type Turn = { session: string; prompt: string };

let temps: string[] = [];

afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps = [];
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-open-pr-"));
  temps.push(dir);
  return dir;
}

const WRITTEN = { title: "feat: add a toggle", body: "the written body" };

const pr = {
  number: 7,
  url: "https://github.test/pr/7",
  state: "OPEN",
  baseRefName: "main",
  isDraft: false,
  isInMergeQueue: false,
};

function harness(dir: string) {
  const ensured: Ensured[] = [];
  const turns: Turn[] = [];
  const shown: string[] = [];
  let sessions = 0;

  const agent = {
    open: () => {
      sessions += 1;
      return Promise.resolve(`session-${sessions}`);
    },
    turn: (session: string, ask: { skill: string; prompt?: string }) => {
      turns.push({ session, prompt: ask.prompt ?? "" });
      return { output: (async function* () {})(), value: Promise.resolve(WRITTEN) };
    },
  };
  const vcs = {
    head: () => Promise.resolve({ branch: "widget", sha: "f00d", detached: false }),
    sync: () => Promise.resolve({ conflicted: false, baseSha: "abc", same: false }),
    subjects: () => Promise.resolve({ subjects: ["add the widget"] }),
    against: () => Promise.resolve({ text: "the diff", truncated: false }),
  };
  const github = {
    pr: {
      titles: () => Promise.resolve(["feat: add a panel"]),
      ensure: (options: Ensured) => {
        ensured.push(options);
        return Promise.resolve({ landed: false, pr, created: true });
      },
      changes: () => ({ next: () => Promise.resolve({ kind: "closed", state: "MERGED" }) }),
      threads: () => Promise.resolve([]),
    },
    branch: { moved: () => ({ next: () => new Promise<never>(() => {}) }) },
  };
  const view = {
    show: () => Promise.resolve(),
    act: () => Promise.resolve(),
    status: () => Promise.resolve(),
    ask: () => Promise.resolve("ok"),
    image: (file: string) => {
      shown.push(file);
      return Promise.resolve();
    },
    listen: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<never>(() => {}),
        return: () => Promise.resolve({ done: true, value: undefined }),
      }),
    }),
  };
  const brief = { where: () => Promise.resolve(path.join(dir, "review.json")) };
  const hooks = { spawn: () => Promise.resolve({ committed: true, message: "add the widget" }) };
  const params = { base: "main", note: "the note", ticket: "" };
  const ctx = {
    agent,
    brief,
    github,
    vcs,
    view,
    params,
    [RUN]: hooks,
  } as unknown as Ctx<typeof params>;
  return { ensured, turns, shown, run: () => openPr.run(ctx as never) };
}

test("the branch's brief is the body, and the writer titles the page it carries", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "review.md"), "# The change\n\nit toggles");
  fs.writeFileSync(path.join(dir, "review.png"), "");
  const bench = harness(dir);

  await bench.run();

  expect(bench.ensured[0]?.body).toBe("# The change\n\nit toggles\n\nthe note");
  expect(bench.turns[0]?.prompt).toContain("# The change\n\nit toggles");
  expect(bench.shown).toEqual([path.join(dir, "review.png")]);
});

test("a branch with no brief keeps the body the writer wrote", async () => {
  const bench = harness(tempDir());

  await bench.run();

  expect(bench.ensured[0]?.body).toBe("the written body\n\nthe note");
  expect(bench.turns[0]?.prompt).not.toContain("# The brief");
  expect(bench.shown).toEqual([]);
});
