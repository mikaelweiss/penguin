import { expect, test } from "bun:test";
import type { Ctx } from "penguin";
import { bearings, discover, type Bearings } from "../examples/helpers/discover.ts";
import implement from "../examples/workflows/implement.ts";

type Ask = string | { skill: string; prompt?: string };
type Opened = Record<string, unknown>;
type Turn = { session: string; ask: Ask };

function said(ask: Ask): string {
  return typeof ask === "string" ? ask : (ask.prompt ?? "");
}

function harness(values: unknown[]) {
  const opens: Opened[] = [];
  const turns: Turn[] = [];
  const agent = {
    open: (options?: Opened) => {
      opens.push(options ?? {});
      return Promise.resolve(`session-${opens.length}`);
    },
    turn: (session: string, ask: Ask) => {
      turns.push({ session, ask });
      return {
        output: (async function* () {})(),
        value: Promise.resolve(values[turns.length - 1] ?? {}),
      };
    },
  };
  const view = { show: () => Promise.resolve(), act: () => Promise.resolve() };
  const gates = { run: () => Promise.resolve({ green: true, report: "bun test: pass" }) };
  const vcs = { status: () => Promise.resolve({ files: [{ status: "M", path: "src/edited.ts" }] }) };
  const ctx = { agent, gates, vcs, view } as unknown as Ctx<unknown>;
  return { opens, turns, ctx };
}

const scouted: Bearings = {
  files: ["src/widget.ts", "src/widget.test.ts"],
  found: "the widget builds its own model",
  missing: "no fixture for the empty case",
};

test("the scout runs on the small model, read-only", async () => {
  const bench = harness([scouted]);

  await discover(bench.ctx, { task: "add a toggle" });

  expect(bench.opens).toEqual([
    { model: "small", tools: ["Read", "Grep", "Glob", "Bash"] },
  ]);
  expect(bench.turns).toHaveLength(1);
  expect(said(bench.turns[0]?.ask ?? "")).toContain("add a toggle");
});

test("a cwd reaches the session, and only when one is given", async () => {
  const bench = harness([scouted]);

  await discover(bench.ctx, { task: "add a toggle", cwd: "/tmp/trees/widget" });

  expect(bench.opens[0]?.["cwd"]).toBe("/tmp/trees/widget");
});

test("the paths come back trimmed, deduped, and in the order the scout ranked them", async () => {
  const bench = harness([
    { files: [" src/b.ts", "src/a.ts", "src/b.ts ", "  "], found: "", missing: "" },
  ]);

  const found = await discover(bench.ctx, { task: "add a toggle" });

  expect(found.files).toEqual(["src/b.ts", "src/a.ts"]);
});

test("the report renders as the section a working turn reads first", () => {
  const text = bearings(scouted);

  expect(text).toContain("- src/widget.ts");
  expect(text).toContain("the widget builds its own model");
  expect(text).toContain("no fixture for the empty case");
});

test("a scout that found nothing and missed nothing adds no section", () => {
  expect(bearings({ files: [], found: "", missing: "" })).toBe("");
  expect(bearings({ files: [], found: "", missing: "the router" })).toContain("the router");
});

test("implement scouts before it opens the implementer, and briefs it with the list", async () => {
  const bench = harness([scouted, {}, { verdict: "approved", blocking: "", notes: "" }]);

  const out = await implement.run({
    ...bench.ctx,
    params: { task: "add a toggle", rounds: 3, baseline: "", base: "" },
  } as never);

  expect(out.approved).toBe(true);
  expect(bench.opens[0]?.["model"]).toBe("small");
  expect(bench.turns[0]?.session).toBe("session-1");
  expect(bench.turns[1]?.session).toBe("session-2");
  expect(said(bench.turns[1]?.ask ?? "")).toContain("- src/widget.ts");
});

test("the list is sent once: the second round reads it off the session it is already in", async () => {
  const bench = harness([
    scouted,
    {},
    { verdict: "changes_needed", blocking: "the toggle has no test", notes: "" },
    {},
    { verdict: "approved", blocking: "", notes: "" },
  ]);

  await implement.run({
    ...bench.ctx,
    params: { task: "add a toggle", rounds: 2, baseline: "", base: "" },
  } as never);

  const second = said(bench.turns[3]?.ask ?? "");
  expect(second).toContain("the toggle has no test");
  expect(second).not.toContain("src/widget.ts");
});

test("the reviewer still gets the tree's own list, not the scout's", async () => {
  const bench = harness([scouted, {}, { verdict: "approved", blocking: "", notes: "" }]);

  await implement.run({
    ...bench.ctx,
    params: { task: "add a toggle", rounds: 1, baseline: "", base: "" },
  } as never);

  const review = said(bench.turns[2]?.ask ?? "");
  expect(review).toContain("- src/edited.ts");
  expect(review).not.toContain("src/widget.ts");
});
