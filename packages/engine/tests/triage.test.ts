import { expect, test } from "bun:test";
import type { Ctx } from "penguin";
import triage from "../examples/workflows/triage.ts";

type Turn = { session: string; prompt: string };
type Opened = Record<string, unknown>;
type Judged = { actionable: boolean; reason: string };

type Options = {
  /** What the agent returns each turn. */
  values?: unknown[];
  /** What the person answers each gate. */
  answers?: string[];
  branches?: string[];
  /** What Jev says each time it is asked. Past the end it says actionable. An Error is thrown instead. */
  judged?: (Judged | Error)[];
};

function harness(options: Options) {
  const values = options.values ?? [];
  const answers = options.answers ?? [];
  const judged = [...(options.judged ?? [])];
  const asked: string[] = [];
  const turns: Turn[] = [];
  const opens: Opened[] = [];
  const shown: string[] = [];
  const tickets: string[] = [];
  const view = {
    show: (text: string) => {
      shown.push(text);
      return Promise.resolve();
    },
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
  const jev = {
    triage: {
      ticket: (one: { ticket: string }) => {
        tickets.push(one.ticket);
        const next = judged.shift() ?? { actionable: true, reason: "the goal is clear enough to build" };
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
    },
  };
  const vcs = { branches: () => Promise.resolve({ branches: options.branches ?? [] }) };
  const ctx = { agent, jev, vcs, view } as unknown as Ctx<unknown>;
  return {
    asked,
    turns,
    opens,
    shown,
    tickets,
    run: (ticket: string) => triage.run({ ...ctx, params: { ticket } } as never),
  };
}

const split = { branch: "widget-sidebar-toggle", tasks: ["build the model"] };
const VAGUE = { actionable: false, reason: "it says no outcome" };

test("Jev reads the ticket, and the turn reads the branch names off the prompt with Read for an attachment", async () => {
  const bench = harness({ values: [split], branches: ["main", "fix-login-timeout"] });

  const out = await bench.run("add a widget to the sidebar");

  expect(out).toEqual({
    actionable: true,
    reason: "the goal is clear enough to build",
    branch: "widget-sidebar-toggle",
    tasks: ["build the model"],
  });
  expect(bench.tickets).toEqual(["add a widget to the sidebar"]);
  expect(bench.opens).toEqual([{ model: "small", tools: ["Read"], settings: [] }]);
  expect(bench.turns[0]?.prompt).toBe(
    "add a widget to the sidebar\n\n# Recent branch names\n\nmain\nfix-login-timeout",
  );
});

test("a repository with no branch leaves the ticket as the whole prompt", async () => {
  const bench = harness({ values: [split] });

  await bench.run("add a widget to the sidebar");

  expect(bench.turns[0]?.prompt).toBe("add a widget to the sidebar");
});

test("what Jev finds missing goes to the person, and their words join the ticket for Jev and the turn", async () => {
  const bench = harness({ values: [split], answers: ["hide completed items"], judged: [VAGUE] });

  const out = await bench.run("add a widget to the sidebar");

  expect(bench.asked).toEqual([
    "The ticket is not ready to build: it says no outcome\n\nAdd what is missing, or stop.",
  ]);
  expect(bench.tickets).toEqual([
    "add a widget to the sidebar",
    "add a widget to the sidebar\n\n# Clarifications\n\nhide completed items",
  ]);
  expect(bench.turns[0]?.prompt).toBe(
    "add a widget to the sidebar\n\n# Clarifications\n\nhide completed items",
  );
  expect(out.actionable).toBe(true);
});

test("a ticket the person will not clarify returns not actionable, and no session opens", async () => {
  const bench = harness({ answers: ["stop"], judged: [VAGUE] });

  const out = await bench.run("make it better");

  expect(out).toEqual({ actionable: false, reason: "it says no outcome", branch: "", tasks: [] });
  expect(bench.opens).toEqual([]);
  expect(bench.shown).toEqual(["not actionable: it says no outcome"]);
});

test("a ticket that attaches files skips Jev, and the split opens them", async () => {
  const bench = harness({ values: [split] });
  const ticket = "# Attached files\n\n/work/shot.png\n\nfix this";

  const out = await bench.run(ticket);

  expect(bench.tickets).toEqual([]);
  expect(bench.asked).toEqual([]);
  expect(bench.turns[0]?.prompt).toBe(ticket);
  expect(out.actionable).toBe(true);
  expect(out.reason).toBe("the ticket attaches files, which the split reads");
});

test("a Jev that will not answer sends the ticket to the split as it is", async () => {
  const bench = harness({ values: [split], judged: [new Error("TypeSafe answered 500")] });

  const out = await bench.run("add a widget to the sidebar");

  expect(out.branch).toBe("widget-sidebar-toggle");
  expect(bench.asked).toEqual([]);
  expect(bench.shown[0]).toContain("TypeSafe answered 500");
});

test("a split the person will not take goes back as a revision", async () => {
  const two = { ...split, tasks: ["build the model", "build the screen"] };
  const bench = harness({ values: [two, split], answers: ["split it by layer instead"] });

  const out = await bench.run("add a widget to the sidebar");

  expect(out.tasks).toEqual(["build the model"]);
  expect(bench.turns[1]?.prompt).toBe(
    "# The revision the user asks for\n\nsplit it by layer instead",
  );
});

test("a turn that returns no task gets the ticket as the one task", async () => {
  const bench = harness({ values: [{ ...split, tasks: [] }] });

  const out = await bench.run("add a widget to the sidebar");

  expect(out.tasks).toEqual(["add a widget to the sidebar"]);
});
