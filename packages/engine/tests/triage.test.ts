import { expect, test } from "bun:test";
import type { Ctx } from "penguin";
import triage from "../examples/workflows/triage.ts";

type Turn = { session: string; prompt: string };
type Opened = Record<string, unknown>;

function harness(values: unknown[], answers: string[], branches: string[] = []) {
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
    turn: (session: string, ask: { prompt?: string }) => {
      turns.push({ session, prompt: ask.prompt ?? "" });
      return {
        output: (async function* () {})(),
        value: Promise.resolve(values[turns.length - 1] ?? {}),
      };
    },
  };
  const vcs = { branches: () => Promise.resolve({ branches }) };
  const ctx = { agent, vcs, view } as unknown as Ctx<unknown>;
  return {
    asked,
    turns,
    opens,
    run: (ticket: string) => triage.run({ ...ctx, params: { ticket } } as never),
  };
}

const triaged = {
  actionable: true,
  reason: "the goal is one sentence",
  branch: "widget sidebar toggle",
  tasks: ["build the model"],
};

test("the turn reads the branch names off the prompt, and carries Read for an attachment", async () => {
  const bench = harness([{ result: triaged }], [], ["main", "fix-login-timeout"]);

  const out = await bench.run("add a widget to the sidebar");

  expect(out.branch).toBe("widget sidebar toggle");
  expect(bench.opens).toEqual([{ model: "small", tools: ["Read"], settings: [] }]);
  expect(bench.turns[0]?.prompt).toBe(
    "add a widget to the sidebar\n\n# Recent branch names\n\nmain\nfix-login-timeout",
  );
});

test("a repository with no branch leaves the ticket as the whole prompt", async () => {
  const bench = harness([{ result: triaged }], []);

  await bench.run("add a widget to the sidebar");

  expect(bench.turns[0]?.prompt).toBe("add a widget to the sidebar");
});

test("blocked questions come back as answers on the same session", async () => {
  const bench = harness(
    [{ blocked: { questions: ["which sidebar?"] } }, { result: triaged }],
    ["the left one"],
  );

  await bench.run("add a widget to the sidebar");

  expect(bench.asked).toEqual(["which sidebar?"]);
  expect(bench.turns.map((turn) => turn.session)).toEqual(["session-1", "session-1"]);
  expect(bench.turns[1]?.prompt).toBe("# Answers\n\nwhich sidebar?\nthe left one");
});

test("a split the person will not take goes back as a revision", async () => {
  const split = { ...triaged, tasks: ["build the model", "build the screen"] };
  const bench = harness([{ result: split }, { result: triaged }], ["split it by layer instead"]);

  const out = await bench.run("add a widget to the sidebar");

  expect(out.tasks).toEqual(["build the model"]);
  expect(bench.turns[1]?.prompt).toBe(
    "# The revision the user asks for\n\nsplit it by layer instead",
  );
});

test("a ticket nothing can be built from returns without a gate", async () => {
  const bench = harness([{ result: { ...triaged, actionable: false } }], []);

  const out = await bench.run("make it better");

  expect(out.actionable).toBe(false);
  expect(bench.asked).toEqual([]);
});
