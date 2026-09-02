import { expect, test } from "bun:test";
import type { Ctx } from "penguin";
import triage, { triageOn } from "../examples/workflows/triage.ts";

type Turn = { session: string; prompt: string };

function harness(values: unknown[], answers: string[]) {
  const asked: string[] = [];
  const turns: Turn[] = [];
  const sessions: string[] = [];
  const view = {
    show: () => Promise.resolve(),
    act: () => Promise.resolve(),
    ask: (question: string) => {
      asked.push(question);
      return Promise.resolve(answers[asked.length - 1] ?? "approve");
    },
  };
  const agent = {
    open: () => {
      const session = `session-${sessions.length + 1}`;
      sessions.push(session);
      return Promise.resolve(session);
    },
    turn: (session: string, ask: { prompt?: string }) => {
      turns.push({ session, prompt: ask.prompt ?? "" });
      return {
        output: (async function* () {})(),
        value: Promise.resolve(values[turns.length - 1] ?? {}),
      };
    },
  };
  const ctx = { agent, view } as unknown as Ctx<unknown>;
  return { asked, turns, sessions, ctx, agent, view };
}

const triaged = {
  actionable: true,
  reason: "src/widget.ts holds it",
  branch: "widget sidebar toggle",
  tasks: ["build the model"],
  context: "src/widget.ts holds the model",
};

test("the standalone workflow triages the ticket in a session of its own", async () => {
  const bench = harness([{ result: triaged }], []);

  const out = await triage.run({
    ...bench.ctx,
    params: { ticket: "add a widget to the sidebar" },
  } as never);

  expect(out.branch).toBe("widget sidebar toggle");
  expect(bench.sessions).toEqual(["session-1"]);
  expect(bench.turns[0]?.prompt).toBe("add a widget to the sidebar");
});

test("blocked questions come back as answers on the same session", async () => {
  const bench = harness(
    [{ blocked: { questions: ["which sidebar?"] } }, { result: triaged }],
    ["the left one"],
  );

  await triageOn(bench.ctx, "session", "add a widget to the sidebar");

  expect(bench.asked).toEqual(["which sidebar?"]);
  expect(bench.turns.map((turn) => turn.session)).toEqual(["session", "session"]);
  expect(bench.turns[1]?.prompt).toBe("# Answers\n\nwhich sidebar?\nthe left one");
});

test("a split the person will not take goes back as a revision", async () => {
  const split = { ...triaged, tasks: ["build the model", "build the screen"] };
  const bench = harness([{ result: split }, { result: triaged }], ["split it by layer instead"]);

  const out = await triageOn(bench.ctx, "session", "add a widget to the sidebar");

  expect(out.tasks).toEqual(["build the model"]);
  expect(bench.turns[1]?.prompt).toBe(
    "# The revision the user asks for\n\nsplit it by layer instead",
  );
});

test("a ticket nothing can be built from returns without a gate", async () => {
  const bench = harness([{ result: { ...triaged, actionable: false } }], []);

  const out = await triageOn(bench.ctx, "session", "make it better");

  expect(out.actionable).toBe(false);
  expect(bench.asked).toEqual([]);
});
