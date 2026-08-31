import { expect, test } from "bun:test";

import type { ActionItem, ActionKind, OutputLine, Run, TranscriptItem } from "@/lib/runs";
import { reuseRows, startsTurn, summarizeActions, toRows } from "@/lib/transcript";

function line(id: string, kind: OutputLine["kind"], at: string, text = id): OutputLine {
  return { id, kind, text, at };
}

function act(id: string, kind: ActionKind, at: string, extra: Partial<ActionItem> = {}): ActionItem {
  return { type: "action", id, name: id, kind, status: "done", at, ...extra };
}

function run(output: TranscriptItem[], rest: Partial<Run> = {}): Run {
  return {
    id: "r1",
    name: "r1",
    status: "running",
    dir: "/work",
    cwd: "/work",
    at: "t0",
    listening: false,
    input: [],
    output,
    opens: [],
    children: [],
    ...rest,
  };
}

function said(id: string, kind: OutputLine["kind"], at: string): TranscriptItem {
  return { type: "line", line: line(id, kind, at) };
}

function turn(id: string, agent: number, at: string, skill?: string): TranscriptItem {
  return { type: "turn", id, agent, at, ...(skill === undefined ? {} : { skill }) };
}

test("a question and its answer share a call id but never a row key", () => {
  const rows = toRows(run([said("c4", "ask", "t1"), said("c4", "answer", "t2")]), []);

  expect(rows.map((row) => row.key)).toEqual(["line:ask:c4", "line:answer:c4"]);
});

test("a sent message sorts by when it was sent, so later output lands below it", () => {
  const rows = toRows(
    run([said("c1", "show", "t1"), said("c3", "show", "t3")]),
    [line("sent:0", "message", "t2")],
  );

  expect(rows.map((row) => row.key)).toEqual([
    "line:show:c1",
    "line:message:sent:0",
    "line:show:c3",
  ]);
});

test("contiguous tool calls of every kind fold into one row", () => {
  const rows = toRows(
    run([act("a1", "read", "t1"), act("a2", "run", "t2"), act("a3", "edit", "t3")]),
    [],
  );

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "actions", key: "actions:a1", failures: 0 });
});

test("a group counts the files it touched, not the calls it made", () => {
  const summary = summarizeActions([
    act("a1", "edit", "t1", { target: "app.ts" }),
    act("a2", "edit", "t2", { target: "app.ts" }),
    act("a3", "edit", "t3", { target: "main.ts" }),
  ]);

  expect(summary).toBe("Changed 2 files");
});

test("a mixed group reads as a sentence", () => {
  const summary = summarizeActions([
    act("a1", "read", "t1", { target: "a.ts" }),
    act("a2", "run", "t2"),
    act("a3", "run", "t3"),
    act("a4", "edit", "t4", { target: "b.ts" }),
  ]);

  expect(summary).toBe("Read 1 file, ran 2 commands, and changed 1 file");
});

test("a tool with no kind still counts", () => {
  expect(summarizeActions([{ type: "action", id: "a1", name: "mcp", status: "done", at: "t1" }])).toBe(
    "Used 1 tool",
  );
});

test("a failed call is counted on its group", () => {
  const rows = toRows(
    run([act("a1", "run", "t1"), act("a2", "run", "t2", { status: "failed" })]),
    [],
  );

  expect(rows[0]).toMatchObject({ kind: "actions", failures: 1 });
});

test("an unchanged tick hands every row back its previous identity", () => {
  const output = [said("c1", "show", "t1"), act("a1", "read", "t2")];
  const before = toRows(run(output), []);
  const after = reuseRows(before, toRows(run(structuredClone(output)), []));

  expect(after).toBe(before);
});

test("a new row leaves the rows before it untouched", () => {
  const output = [said("c1", "show", "t1")];
  const before = toRows(run(output), []);
  const after = reuseRows(before, toRows(run([...output, said("c2", "show", "t2")]), []));

  expect(after).not.toBe(before);
  expect(after[0]).toBe(before[0]);
  expect(after[1]!.key).toBe("line:show:c2");
});

test("a running call that finishes gives its group a fresh identity", () => {
  const before = toRows(run([act("a1", "run", "t1", { status: "running" })]), []);
  const after = reuseRows(
    before,
    toRows(run([act("a1", "run", "t1", { status: "done", output: "ok" })]), []),
  );

  expect(after[0]).not.toBe(before[0]);
});

test("the closing row sits at the end", () => {
  const finished = toRows(run([], { status: "done" }), []);
  expect(finished.map((row) => row.key)).toEqual(["closing"]);
});

test("a run's problem becomes its own row", () => {
  const rows = toRows(run([], { status: "failed", problem: "boom" }), []);

  expect(rows.map((row) => row.key)).toEqual(["closing", "line:problem"]);
});

test("the scroller anchors on what the person sent, not on the run's own output", () => {
  const rows = toRows(
    run([said("c1", "show", "t1")], { input: [{ name: "task", text: "go" }] }),
    [line("sent:0", "message", "t2")],
  );

  expect(rows.filter(startsTurn).map((row) => row.key)).toEqual([
    "input",
    "line:message:sent:0",
  ]);
});

test("a turn boundary breaks the fold, so the next step's work is its own group", () => {
  const rows = toRows(
    run([act("a1", "run", "t1"), turn("t1", 1, "t2", "implement"), act("a2", "run", "t3")]),
    [],
  );

  expect(rows.map((row) => row.key)).toEqual(["actions:a1", "turn:t1", "actions:a2"]);
});

test("one agent working alone is named by its step, with no number to tell it apart", () => {
  const rows = toRows(run([turn("t1", 1, "t1", "plan")]), []);

  expect(rows[0]).toMatchObject({ kind: "turn", label: "plan" });
});

test("a run passing work between agents says which one took each step", () => {
  const rows = toRows(
    run([turn("t1", 1, "t1", "implement"), turn("t2", 2, "t2", "review")]),
    [],
  );

  expect(rows.map((row) => (row.kind === "turn" ? row.label : row.key))).toEqual([
    "implement · agent 1",
    "review · agent 2",
  ]);
});

test("a turn on a bare prompt falls back to naming the agent", () => {
  const rows = toRows(run([turn("t1", 1, "t1"), turn("t2", 2, "t2")]), []);

  expect(rows.map((row) => (row.kind === "turn" ? row.label : row.key))).toEqual([
    "agent 1",
    "agent 2",
  ]);
});

test("the scroller anchors on each new step", () => {
  const rows = toRows(
    run([said("c1", "show", "t1"), turn("t1", 1, "t2", "review")]),
    [],
  );

  expect(rows.filter(startsTurn).map((row) => row.key)).toEqual(["turn:t1"]);
});
