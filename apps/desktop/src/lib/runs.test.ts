import { expect, test } from "bun:test";

import { nextView } from "@/lib/runs";
import type { Follow, Project, Run, RunStatus } from "@/lib/runs";

type Sketch = { id: string; status?: RunStatus; children?: Sketch[] };

function run(sketch: Sketch): Run {
  return {
    id: sketch.id,
    name: sketch.id,
    status: sketch.status ?? "running",
    dir: "/work",
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
