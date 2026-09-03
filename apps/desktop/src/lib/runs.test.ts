import { expect, test } from "bun:test";

import {
  blockedOn,
  costLabel,
  isLive,
  needsYouNotice,
  newlyBlocked,
  nextView,
  pausedReason,
  resumable,
  subtreeCost,
  toProjects,
  unfinished,
} from "@/lib/runs";
import type { Ask, Auth, Follow, Project, Run, RunFile, RunStatus } from "@/lib/runs";

type Sketch = {
  id: string;
  status?: RunStatus;
  ask?: Partial<Ask>;
  auth?: Partial<Auth>;
  children?: Sketch[];
};

function run(sketch: Sketch): Run {
  return {
    id: sketch.id,
    name: sketch.id,
    status: sketch.status ?? "running",
    dir: "/work",
    cwd: "/work",
    at: "t1",
    ...(sketch.ask === undefined
      ? {}
      : { ask: { prompt: "which one?", schema: undefined, problem: undefined, ...sketch.ask } }),
    ...(sketch.auth === undefined
      ? {}
      : { auth: { role: "jira", reason: "", at: "t1", ...sketch.auth } }),
    listening: false,
    input: [],
    output: [],
    opens: [],
    children: (sketch.children ?? []).map(run),
  };
}

function tree(...sketches: Sketch[]): Project[] {
  return [{ id: "/work", name: "work", dir: "/work", runs: sketches.map(run) }];
}

function latch(parent: string, ...known: string[]): Follow {
  return { parent, known: new Set(known) };
}

test("a finished child sends the view up to its parent, latched on the children it had", () => {
  const before = tree({ id: "work", children: [{ id: "plan" }] });
  const after = tree({ id: "work", children: [{ id: "plan", status: "done" }] });

  expect(nextView(before, after, "plan", undefined)).toEqual({
    select: "work",
    follow: latch("work", "plan"),
  });
});

test("the latched parent's next child pulls the view in and spends the latch", () => {
  const before = tree({ id: "work", children: [{ id: "plan", status: "done" }] });
  const after = tree({
    id: "work",
    children: [{ id: "plan", status: "done" }, { id: "implement" }],
  });

  expect(nextView(before, after, "work", latch("work", "plan"))).toEqual({
    select: "implement",
    follow: undefined,
  });
});

test("a finish and the next spawn in one tick still leave the new child unknown", () => {
  const before = tree({ id: "work", children: [{ id: "plan" }] });
  const after = tree({
    id: "work",
    children: [{ id: "plan", status: "done" }, { id: "implement" }],
  });

  const up = nextView(before, after, "plan", undefined);
  expect(up).toEqual({ select: "work", follow: latch("work", "plan") });

  expect(nextView(before, after, "work", up?.follow)).toEqual({
    select: "implement",
    follow: undefined,
  });
});

test("a sibling that was already running when the watched run finished is a bystander", () => {
  const before = tree({ id: "queue", children: [{ id: "pr-1" }, { id: "pr-2" }] });
  const after = tree({ id: "queue", children: [{ id: "pr-1", status: "done" }, { id: "pr-2" }] });

  const up = nextView(before, after, "pr-1", undefined);
  expect(up).toEqual({ select: "queue", follow: latch("queue", "pr-1", "pr-2") });
  expect(nextView(before, after, "queue", up?.follow)).toBeUndefined();
});

test.each(["failed", "stopped", "paused"] as const)("a %s run keeps the view", (status) => {
  const before = tree({ id: "work", children: [{ id: "plan" }] });
  const after = tree({ id: "work", children: [{ id: "plan", status }] });

  expect(nextView(before, after, "plan", undefined)).toBeUndefined();
});

test("a run first seen as done never moves the view", () => {
  const done = tree({ id: "work", children: [{ id: "plan", status: "done" }] });

  expect(nextView([], done, "plan", undefined)).toBeUndefined();
  expect(nextView(done, done, "plan", undefined)).toBeUndefined();
});

test("a run finishing somewhere else leaves the view alone", () => {
  const before = tree({ id: "work", children: [{ id: "plan" }, { id: "implement" }] });
  const after = tree({
    id: "work",
    children: [{ id: "plan", status: "done" }, { id: "implement" }],
  });

  expect(nextView(before, after, "implement", undefined)).toBeUndefined();
});

test("a finished root run has no parent to ride to", () => {
  const before = tree({ id: "work" });
  const after = tree({ id: "work", status: "done" });

  expect(nextView(before, after, "work", undefined)).toBeUndefined();
});

test("a latch on some other run ignores that run's new children", () => {
  const before = tree({ id: "work", children: [{ id: "plan" }, { id: "review" }] });
  const after = tree({
    id: "work",
    children: [{ id: "plan" }, { id: "review", children: [{ id: "notes" }] }],
  });

  expect(nextView(before, after, "plan", latch("review"))).toBeUndefined();
});

test("a run that vanished from the tree moves nothing", () => {
  const before = tree({ id: "work", children: [{ id: "plan" }] });

  expect(nextView(before, tree({ id: "work" }), "plan", undefined)).toBeUndefined();
  expect(nextView(before, before, undefined, undefined)).toBeUndefined();
});

test("credentials outrank a question, the way the output area orders them", () => {
  expect(blockedOn(run({ id: "work", ask: {}, auth: {} }))).toBe("auth:jira:t1");
  expect(blockedOn(run({ id: "work", ask: {} }))).toBe("ask:which one?:");
  expect(blockedOn(run({ id: "work" }))).toBeUndefined();
});

test("a run that starts waiting is reported once and not again while it waits", () => {
  const free = tree({ id: "work", children: [{ id: "plan" }] });
  const asking = tree({ id: "work", children: [{ id: "plan", ask: {} }] });

  expect(newlyBlocked(free, asking).map((waiting) => waiting.id)).toEqual(["plan"]);
  expect(newlyBlocked(asking, asking)).toEqual([]);
});

test("a fresh question, a refusal, and new credentials each count as a new call", () => {
  const asking = tree({ id: "plan", ask: {} });
  const again = tree({ id: "plan", ask: { prompt: "and now?" } });
  const refused = tree({ id: "plan", ask: { problem: "not a number" } });
  const auth = tree({ id: "plan", auth: {} });
  const later = tree({ id: "plan", auth: { at: "t2" } });

  expect(newlyBlocked(asking, again).map((waiting) => waiting.id)).toEqual(["plan"]);
  expect(newlyBlocked(asking, refused).map((waiting) => waiting.id)).toEqual(["plan"]);
  expect(newlyBlocked(auth, later).map((waiting) => waiting.id)).toEqual(["plan"]);
});

test("a run that stops waiting, by answer or by finishing, is reported by nobody", () => {
  const asking = tree({ id: "plan", ask: {} });

  expect(newlyBlocked(asking, tree({ id: "plan" }))).toEqual([]);
  expect(newlyBlocked(asking, tree({ id: "plan", status: "done" }))).toEqual([]);
});

test("two runs blocking on one tick are reported separately, however deep they sit", () => {
  const before = tree({ id: "work", children: [{ id: "plan" }, { id: "review" }] });
  const after = tree({
    id: "work",
    children: [{ id: "plan", ask: {} }, { id: "review", children: [{ id: "notes", auth: {} }] }],
  });

  expect(newlyBlocked(before, after).map((waiting) => waiting.id)).toEqual(["plan", "notes"]);
});

test("the notice names the run and says what it waits on", () => {
  expect(needsYouNotice(run({ id: "plan", auth: { role: "jira" } }))).toEqual({
    title: "plan needs you",
    body: "Waiting on jira credentials",
  });
  expect(needsYouNotice(run({ id: "plan", ask: { problem: "not a number" } }))?.body).toBe(
    "not a number",
  );
  expect(needsYouNotice(run({ id: "plan" }))).toBeUndefined();
});

test("a long or many-lined question is flattened to one capped line", () => {
  const asked = needsYouNotice(run({ id: "plan", ask: { prompt: "pick one:\n  a\n  b" } }));
  expect(asked?.body).toBe("pick one: a b");

  const long = needsYouNotice(run({ id: "plan", ask: { prompt: "x".repeat(400) } }));
  expect(long?.body).toHaveLength(200);
  expect(long?.body.endsWith("\u2026")).toBe(true);
});

function file(id: string, root: string, at: string): RunFile {
  return {
    id,
    entries: [{ at, run: id, workflow: `${root}/ship.ts`, params: {}, cwd: root, root }],
    alive: false,
  };
}

test("a directory with no run still gets a row, and a run invents the project it names", () => {
  const projects = toProjects([file("a", "/work", "t2")], ["/idle"]);

  expect(projects.map((project) => project.dir)).toEqual(["/idle", "/work"]);
});

test("a hidden root keeps out the runs it held, so nothing invents the project again", () => {
  const files = [file("a", "/work", "t1"), file("b", "/other", "t1")];

  expect(toProjects(files, [], { "/work": "t1" }).map((project) => project.dir)).toEqual(["/other"]);
});

test("a run newer than the hiding brings the project back", () => {
  const files = [file("a", "/work", "t1"), file("b", "/work", "t3")];
  const projects = toProjects(files, [], { "/work": "t2" });

  expect(projects.map((project) => project.dir)).toEqual(["/work"]);
  expect(projects[0]?.runs.map((run) => run.id)).toEqual(["b"]);
});

const HEAD = { run: "a", workflow: "/work/ship.ts", params: {}, cwd: "/work", root: "/work" };

/** A run file, its start entry followed by what the run appended, with or without a process behind it. */
function written(alive: boolean, ...entries: Record<string, unknown>[]): RunFile {
  return { id: "a", entries: [{ at: "t1", ...HEAD }, ...entries], alive };
}

function live(...entries: Record<string, unknown>[]): RunFile {
  return written(true, ...entries);
}

function only(files: RunFile[]): Run {
  const found = toProjects(files, [])[0]?.runs[0];
  if (found === undefined) throw new Error("no run");
  return found;
}

test("a dead process that wrote no ending leaves the run paused, interrupted", () => {
  const run = only([written(false, { at: "t2", call: "view.show", args: ["hi"], pending: true })]);

  expect(run.status).toBe("paused");
  expect(run.paused).toEqual({ by: "interrupted", at: "t2" });
  expect(unfinished(run)).toBe(true);
  expect(resumable(run)).toBe(true);
  expect(isLive(run)).toBe(false);
});

test("a limit's paused note says who parked the run and when it comes back", () => {
  const note = { by: "limit" as const, reason: "resets 3pm", until: "2026-09-02T15:00:00.000Z" };
  const run = only([written(false, { at: "t2", paused: note })]);

  expect(run.status).toBe("paused");
  expect(run.paused).toEqual({ ...note, at: "t2" });
  expect(pausedReason(run.paused!)).toBe("resets 3pm");
});

test("an error's paused note carries the agent's own words, and an unknown kind reads as a person's", () => {
  const note = { by: "error" as const, reason: "API Error: 500" };
  const broken = only([written(false, { at: "t2", paused: note })]);

  expect(broken.status).toBe("paused");
  expect(broken.paused).toEqual({ ...note, at: "t2" });
  expect(pausedReason(broken.paused!)).toBe("API Error: 500");

  const later = only([written(false, { at: "t2", paused: { by: "whatever-comes-next" } })]);
  expect(later.paused).toEqual({ by: "user", at: "t2" });
});

test("a person's pause needs no reason, and their stop of a parked run ends it", () => {
  const paused = only([written(false, { at: "t2", paused: { by: "user" } })]);
  expect(paused.paused).toEqual({ by: "user", at: "t2" });
  expect(pausedReason(paused.paused!)).toBeUndefined();

  const closed = only([written(false, { at: "t2", paused: { by: "user" } }, { at: "t3", stopped: true })]);
  expect(closed.status).toBe("stopped");
  expect(closed.paused).toBeUndefined();
});

test("a resumed run reads from its latest segment, the earlier pause being history", () => {
  const ask = { call: "view.ask", args: ["which?"], id: "c1", pending: true };
  const run = only([
    live(
      { at: "t2", ...ask },
      { at: "t3", paused: { by: "user" } },
      { at: "t4", ...HEAD },
      { at: "t5", call: "view.ask", args: ["which?"], id: "c2", pending: true },
    ),
  ]);

  expect(run.status).toBe("running");
  expect(run.ask?.prompt).toBe("which?");
  expect(run.output.map((item) => (item.type === "line" ? item.line.kind : item.type))).toEqual([
    "ask",
    "mark",
    "mark",
    "ask",
  ]);
  expect(run.output.flatMap((item) => (item.type === "mark" ? [item.text] : []))).toEqual([
    "run paused",
    "resumed",
  ]);
});

test("a run resumed after failing or stopping tells how each earlier segment ended", () => {
  const run = only([
    live(
      { at: "t2", call: "view.show", args: ["one"], id: "c1", pending: true },
      { at: "t3", threw: "boom" },
      { at: "t4", ...HEAD },
      { at: "t5", call: "view.show", args: ["two"], id: "c2", pending: true },
      { at: "t6", stopped: true },
      { at: "t7", ...HEAD },
      { at: "t8", call: "view.show", args: ["three"], id: "c3", pending: true },
    ),
  ]);

  expect(run.status).toBe("running");
  expect(run.output.flatMap((item) => (item.type === "mark" ? [item.text] : []))).toEqual([
    "run failed: boom",
    "resumed",
    "run stopped",
    "resumed",
  ]);
});

test("what a resume replayed is not told twice, and a turn's settlement is not a second turn", () => {
  const run = only([
    live(
      { at: "t2", ...HEAD },
      { at: "t3", call: "view.ask", args: ["which?"], outcome: "a", replayed: true },
      { at: "t4", call: "agent.turn", args: ["s1", "go"], id: "c2", handle: true, pending: true },
      { at: "t5", call: "agent.turn", args: ["s1", "go"], id: "c2", handle: true, outcome: { n: 1 } },
      { at: "t6", call: "view.show", args: ["done"], id: "c3", pending: true },
    ),
  ]);

  expect(run.output.map((item) => item.type)).toEqual(["mark", "turn", "line"]);
});

test("usage notes sum into the run's cost, and a child's spend joins the subtree's", () => {
  const spent = only([
    live(
      { at: "t2", usage: { adapter: "claude", session: "s", input: 10, cacheRead: 100, cacheWrite: 5, output: 20, usd: 0.5 } },
      { at: "t3", usage: { adapter: "claude", session: "s", input: 1, cacheRead: 200, cacheWrite: 0, output: 2, usd: 0.25 } },
    ),
  ]);
  expect(spent.cost).toEqual({ turns: 2, input: 11, cacheRead: 300, cacheWrite: 5, output: 22, usd: 0.75 });
  expect(costLabel(spent.cost)).toBe("$0.75");

  const child: Run = { ...spent, id: "child", children: [], cost: { turns: 1, input: 1, cacheRead: 1, cacheWrite: 1, output: 1, usd: 0.05 } };
  const parent: Run = { ...spent, id: "parent", children: [child] };
  expect(subtreeCost(parent)).toEqual({ turns: 3, input: 12, cacheRead: 301, cacheWrite: 6, output: 23, usd: 0.8 });
});

test("a run with no usage notes has no cost, and a tokens-only note keeps usd unknown", () => {
  expect(only([live()]).cost).toBeUndefined();
  expect(costLabel(undefined)).toBeUndefined();

  const counted = only([
    live({ at: "t2", usage: { adapter: "codex", session: "s", input: 1500, cacheRead: 0, cacheWrite: 0, output: 500 } }),
  ]);
  expect(counted.cost).toEqual({ turns: 1, input: 1500, cacheRead: 0, cacheWrite: 0, output: 500 });
  expect(counted.cost?.usd).toBeUndefined();
  expect(costLabel(counted.cost)).toBe("2k tok");
});

test("the last pr.get and issue.get settle what the info panel shows, stamped with when", () => {
  const seen = only([
    live(
      {
        at: "t2",
        call: "github.pr.get",
        args: ["12"],
        id: "c1",
        elapsedMs: 5,
        outcome: {
          ok: true,
          pr: { number: 12, title: "Fix it", state: "OPEN", isDraft: true, isInMergeQueue: false, url: "https://github.com/o/r/pull/12" },
        },
      },
      {
        at: "t3",
        call: "github.pr.get",
        args: ["12"],
        id: "c2",
        elapsedMs: 5,
        outcome: {
          ok: true,
          pr: { number: 12, title: "Fix it", state: "MERGED", isDraft: false, isInMergeQueue: false, url: "https://github.com/o/r/pull/12" },
        },
      },
      {
        at: "t4",
        call: "jira.issue.get",
        args: ["SS-9"],
        id: "c3",
        elapsedMs: 5,
        outcome: { ok: true, issue: { key: "SS-9", summary: "Do the thing", status: "In Progress", url: "https://x.atlassian.net/browse/SS-9" } },
      },
    ),
  ]);
  expect(seen.pr).toEqual({
    number: 12,
    title: "Fix it",
    state: "MERGED",
    isDraft: false,
    isInMergeQueue: false,
    url: "https://github.com/o/r/pull/12",
    at: "t3",
  });
  expect(seen.ticket).toEqual({
    source: "jira",
    name: "SS-9",
    title: "Do the thing",
    status: "In Progress",
    url: "https://x.atlassian.net/browse/SS-9",
    at: "t4",
  });
});

test("a run that read no pr and no ticket shows neither, and keeps where it started", () => {
  const bare = only([live({ at: "t2", dir: "/worktrees/thing" })]);
  expect(bare.pr).toBeUndefined();
  expect(bare.ticket).toBeUndefined();
  expect(bare.dir).toBe("/worktrees/thing");
  expect(bare.cwd).toBe("/work");
  expect(bare.at).toBe("t1");
});
