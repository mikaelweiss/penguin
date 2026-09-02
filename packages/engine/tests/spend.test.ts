import { expect, test } from "bun:test";
import {
  add,
  apiCalls,
  callsPerTurn,
  contextPerCall,
  fresh,
  spendOf,
  turnsOf,
  type Entry,
} from "../examples/helpers/spend.ts";

let journaled = 0;

/** The four entries a run file holds for one tool call: pending and settled, running then settled status. */
function toolCall(name: string, status: "done" | "failed" = "done"): Entry[] {
  journaled += 1;
  const id = journaled;
  const action = { id: `a${id}`, kind: "run", name, target: "ls", status: "running" };
  const settled = { ...action, status, output: "ok" };
  return [
    { at: "2026-09-01T00:00:00.000Z", call: "view.act", id, pending: true, args: [action] },
    { at: "2026-09-01T00:00:00.001Z", call: "view.act", id, elapsedMs: 3, args: [action] },
    { at: "2026-09-01T00:00:00.002Z", call: "view.act", id: id + 1000, pending: true, args: [settled] },
    { at: "2026-09-01T00:00:00.003Z", call: "view.act", id: id + 1000, elapsedMs: 1, args: [settled] },
  ];
}

function note(tokens: Partial<Record<"input" | "cacheRead" | "cacheWrite" | "output", number>>): Entry {
  return {
    at: "2026-09-01T00:00:01.000Z",
    usage: { adapter: "claude", session: "s1", model: "claude-opus-5", ...tokens },
  };
}

test("a turn's tool calls are the ones journaled since the note before it", () => {
  const entries = [
    ...toolCall("Bash"),
    ...toolCall("Read"),
    note({ input: 10 }),
    ...toolCall("Edit"),
    note({ input: 20 }),
  ];
  expect(turnsOf(entries).map((turn) => turn.calls)).toEqual([2, 1]);
});

test("a failed call counts once, and calls after the last note belong to no turn", () => {
  const entries = [...toolCall("Bash", "failed"), note({ input: 10 }), ...toolCall("Bash")];
  const turns = turnsOf(entries);
  expect(turns).toHaveLength(1);
  expect(turns[0]?.calls).toBe(1);
});

test("show entries and a call's settled journaling never count as calls", () => {
  const entries: Entry[] = [
    { at: "2026-09-01T00:00:00.000Z", call: "view.show", id: 1, pending: true, args: ["hello"] },
    ...toolCall("Bash"),
    note({ input: 10 }),
  ];
  expect(turnsOf(entries)[0]?.calls).toBe(1);
});

test("a turn answers every tool call and one more call, and spreads its context over them", () => {
  const spend = spendOf({ input: 1000, cacheRead: 39_000, cacheWrite: 0, output: 500 }, 3);
  expect(apiCalls(spend)).toBe(4);
  expect(contextPerCall(spend)).toBe(10_000);
  expect(callsPerTurn(spend)).toBe(3);
});

test("summed turns average their calls and context, and a turn with no calls still bills one", () => {
  const total = fresh();
  add(total, spendOf({ input: 100, cacheRead: 900, output: 10 }, 4));
  add(total, spendOf({ input: 200, cacheRead: 800, output: 20 }, 0));
  expect(total.turns).toBe(2);
  expect(callsPerTurn(total)).toBe(2);
  expect(apiCalls(total)).toBe(6);
  expect(contextPerCall(total)).toBe(2000 / 6);
});

test("an empty spend reports no calls per turn and no context, never a division by zero", () => {
  expect(callsPerTurn(fresh())).toBe(0);
  expect(contextPerCall(fresh())).toBe(0);
});

test("a note without usd leaves the spend unpriced", () => {
  expect(spendOf({ input: 1 }, 0).priced).toBe(false);
  expect(spendOf({ input: 1, usd: 0.5 }, 0)).toMatchObject({ priced: true, usd: 0.5 });
});
