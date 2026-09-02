import { expect, test } from "bun:test";
import type { Ctx } from "penguin";
import { bearings, type Bearings } from "../examples/helpers/discover.ts";
import plan from "../examples/workflows/plan.ts";

type Turn = { session: string; prompt: string };
type Opened = Record<string, unknown>;

/** The scout answers the first turn, so every list of values starts with what it found. */
function harness(values: unknown[], answers: string[]) {
  const asked: string[] = [];
  const turns: Turn[] = [];
  const opens: Opened[] = [];
  const view = {
    show: () => Promise.resolve(),
    act: () => Promise.resolve(),
    ask: (question: string) => {
      asked.push(question);
      return Promise.resolve(answers[asked.length - 1] ?? "approve");
    },
  };
  const agent = {
    open: (options?: Opened) => {
      opens.push(options ?? {});
      return Promise.resolve(`session-${opens.length}`);
    },
    turn: (session: string, ask: string | { prompt?: string }) => {
      turns.push({ session, prompt: typeof ask === "string" ? ask : (ask.prompt ?? "") });
      return {
        output: (async function* () {})(),
        value: Promise.resolve(values[turns.length - 1] ?? {}),
      };
    },
  };
  const ctx = { agent, view } as unknown as Ctx<unknown>;
  return {
    asked,
    turns,
    opens,
    run: (ticket: string) => plan.run({ ...ctx, params: { ticket } } as never),
  };
}

const scouted: Bearings = {
  files: ["src/widget.ts"],
  found: "the widget builds its own model",
  missing: "",
};
const nothing: Bearings = { files: [], found: "", missing: "" };
const planned = { result: { plan: "the plan", acceptance: "it works" } };

test("the scout finds the files first, and the planner is handed them with the task", async () => {
  const bench = harness([scouted, planned], []);

  const out = await bench.run("build the model");

  expect(out.acceptance).toBe("it works");
  expect(bench.opens[0]).toMatchObject({ model: "small" });
  expect(bench.opens[1]).toEqual({});
  expect(bench.turns.map((turn) => turn.session)).toEqual(["session-1", "session-2"]);
  expect(bench.turns[1]?.prompt).toBe(`build the model\n\n${bearings(scouted)}`);
});

test("a scout that found nothing leaves the task as the whole prompt", async () => {
  const bench = harness([nothing, planned], []);

  await bench.run("build the model");

  expect(bench.turns[1]?.prompt).toBe("build the model");
});

test("blocked questions come back as answers on the planner's session", async () => {
  const bench = harness(
    [scouted, { blocked: { questions: ["which store?"] } }, planned],
    ["the local one"],
  );

  await bench.run("build the model");

  expect(bench.turns.slice(1).map((turn) => turn.session)).toEqual(["session-2", "session-2"]);
  expect(bench.turns[2]?.prompt).toBe("# Answers\n\nwhich store?\nthe local one");
});

test("a plan the person will not approve goes back as a revision", async () => {
  const bench = harness([scouted, planned, planned], ["keep the migration out of it"]);

  const out = await bench.run("build the model");

  expect(out.plan).toBe("the plan");
  expect(bench.turns[2]?.prompt).toBe(
    "# The revision the user asks for\n\nkeep the migration out of it",
  );
});
