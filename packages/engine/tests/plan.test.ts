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
    run: (ticket: string, tasks: string[] = [], done = 0) =>
      plan.run({ ...ctx, params: { ticket, tasks, done } } as never),
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

test("a split shows the planner its task, the ones built, and the ones to come", async () => {
  const bench = harness([nothing, planned], []);
  const tasks = ["build the model", "build the list", "build the screen"];

  const out = await bench.run("add a widget", tasks, 1);

  expect(out.tasks).toEqual(tasks);
  const fence =
    "# The split\n\nThis ticket builds in 3 tasks. Tasks 1 to 1 are in the worktree already. Task 2 is yours.\n\n1. build the model\n2. build the list\n3. build the screen";
  expect(bench.turns[0]?.prompt).toContain(fence);
  expect(bench.turns[1]?.prompt).toBe(`add a widget\n\n${fence}`);
});

test("a decision is put to the person as options, and the pick goes back to the planner", async () => {
  const decide = {
    question: "push or poll?",
    options: [
      { name: "push", tradeoff: "live, but a socket to run" },
      { name: "poll", tradeoff: "a delay, on the pattern the app has" },
    ],
    recommended: "poll",
  };
  const bench = harness([nothing, { decide }, planned], ["poll"]);

  await bench.run("build notifications");

  expect(bench.asked[0]).toBe(
    "push or poll?\n\npush: live, but a socket to run\npoll: a delay, on the pattern the app has\n\nThe planner recommends poll. Pick one, or say what to do instead.",
  );
  expect(bench.turns[2]?.prompt).toBe("# The decision\n\npush or poll?\npoll");
});

test("a resplit the person approves replaces the tasks that remain", async () => {
  const resplit = { reason: "the list and the screen are one component.", tasks: ["build the list and screen"] };
  const bench = harness([nothing, { resplit }, planned], ["approve"]);

  const out = await bench.run("add a widget", ["build the model", "build the list", "build the screen"], 1);

  expect(out.tasks).toEqual(["build the model", "build the list and screen"]);
  expect(bench.asked[0]).toBe(
    "The code changes the split. the list and the screen are one component.\n\nThe work that remains:\n\n1. build the list and screen\n\nApprove the split?",
  );
  expect(bench.turns[2]?.prompt).toBe(
    "# The split is approved\n\n# The split\n\nThis ticket builds in 2 tasks. Tasks 1 to 1 are in the worktree already. Task 2 is yours.\n\n1. build the model\n2. build the list and screen\n\nPlan task 2.",
  );
});

test("a resplit the person will not take goes back as a revision, and the split stands", async () => {
  const resplit = { reason: "one slice.", tasks: ["build it all"] };
  const bench = harness([nothing, { resplit }, planned], ["keep them apart"]);

  const out = await bench.run("add a widget", ["build the model", "build the screen"], 0);

  expect(out.tasks).toEqual(["build the model", "build the screen"]);
  expect(bench.turns[2]?.prompt).toBe("# The revision the user asks for\n\nkeep them apart");
});

test("a plan the person will not approve goes back as a revision", async () => {
  const bench = harness([scouted, planned, planned], ["keep the migration out of it"]);

  const out = await bench.run("build the model");

  expect(out.plan).toBe("the plan");
  expect(bench.turns[2]?.prompt).toBe(
    "# The revision the user asks for\n\nkeep the migration out of it",
  );
});
