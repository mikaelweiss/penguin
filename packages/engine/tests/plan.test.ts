import { expect, test } from "bun:test";
import type { Ctx } from "penguin";
import plan, { planOn } from "../examples/workflows/plan.ts";

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
  return { asked, turns, sessions, ctx };
}

const planned = { result: { plan: "the plan", acceptance: "it works" } };

test("the standalone workflow carries what triage read into its own session", async () => {
  const bench = harness([planned], []);

  const out = await plan.run({
    ...bench.ctx,
    params: { ticket: "build the model", context: "src/widget.ts holds the model" },
  } as never);

  expect(out.acceptance).toBe("it works");
  expect(bench.sessions).toEqual(["session-1"]);
  expect(bench.turns[0]?.prompt).toBe(
    "build the model\n\n# What triage already read\n\nsrc/widget.ts holds the model",
  );
});

test("with no context the ticket is the whole prompt", async () => {
  const bench = harness([planned], []);

  await plan.run({ ...bench.ctx, params: { ticket: "build the model", context: "" } } as never);

  expect(bench.turns[0]?.prompt).toBe("build the model");
});

test("blocked questions come back as answers on the caller's session", async () => {
  const bench = harness([{ blocked: { questions: ["which store?"] } }, planned], ["the local one"]);

  await planOn(bench.ctx, "session", "build the model");

  expect(bench.turns.map((turn) => turn.session)).toEqual(["session", "session"]);
  expect(bench.turns[1]?.prompt).toBe("# Answers\n\nwhich store?\nthe local one");
});

test("a plan the person will not approve goes back as a revision", async () => {
  const bench = harness([planned, planned], ["keep the migration out of it"]);

  const out = await planOn(bench.ctx, "session", "build the model");

  expect(out.plan).toBe("the plan");
  expect(bench.turns[1]?.prompt).toBe(
    "# The revision the user asks for\n\nkeep the migration out of it",
  );
});
