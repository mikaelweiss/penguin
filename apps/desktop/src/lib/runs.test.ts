import { expect, test } from "bun:test";

import { blockedOn, needsYouNotice, newlyBlocked, nextView, toProjects } from "@/lib/runs";
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
    ...(sketch.ask === undefined
      ? {}
      : { ask: { prompt: "which one?", schema: undefined, problem: undefined, ...sketch.ask } }),
    ...(sketch.auth === undefined
      ? {}
      : { auth: { role: "jira", reason: "", at: "t1", ...sketch.auth } }),
    listening: false,
    input: [],
    output: [],
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

test.each(["failed", "stopped", "crashed"] as const)("a %s run keeps the view", (status) => {
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
    entries: [{ at, workflow: `${root}/ship.ts`, params: {}, cwd: root, root }],
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
