import { expect, test } from "bun:test";
import type { Ctx } from "penguin";
import triage from "../examples/workflows/triage.ts";

type Turn = { session: string; prompt: string };
type Opened = Record<string, unknown>;
type Judged = { actionable: boolean; reason: string; missing?: string };

type Options = {
  /** What the agent returns each turn. */
  values?: unknown[];
  /** What the person answers each gate. */
  answers?: string[];
  branches?: string[];
  /** What Jev says each time it is asked. Past the end it says actionable. An Error is thrown instead. */
  judged?: (Judged | Error)[];
};

const READS = { model: "small", tools: ["Read"], settings: [] };
const OPENS = { model: "small", tools: ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "Bash"] };

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

const triaged = {
  actionable: true,
  reason: "the goal is one sentence",
  branch: "widget-sidebar-toggle",
  tasks: ["build the model"],
};
const VAGUE = { actionable: false, reason: "it says no outcome", missing: "goal" };
const POINTS = {
  actionable: false,
  reason: "it points at something it does not identify",
  missing: "reference",
};

test("a ticket Jev passes goes to a turn that only reads, with the branch names on the prompt", async () => {
  const bench = harness({ values: [{ result: triaged }], branches: ["main", "fix-login-timeout"] });

  const out = await bench.run("add a widget to the sidebar");

  expect(out.branch).toBe("widget-sidebar-toggle");
  expect(bench.tickets).toEqual(["add a widget to the sidebar"]);
  expect(bench.opens).toEqual([READS]);
  expect(bench.turns[0]?.prompt).toBe(
    "add a widget to the sidebar\n\n# Recent branch names\n\nmain\nfix-login-timeout",
  );
});

test("a repository with no branch leaves the ticket as the whole prompt", async () => {
  const bench = harness({ values: [{ result: triaged }] });

  await bench.run("add a widget to the sidebar");

  expect(bench.turns[0]?.prompt).toBe("add a widget to the sidebar");
});

test("a ticket pointing where Jev cannot read is the turn's to open and triage", async () => {
  const bench = harness({ values: [{ result: triaged }], judged: [POINTS] });

  const out = await bench.run("resolve the issue at https://example.sentry.io/issues/7746198397/");

  expect(bench.opens).toEqual([OPENS]);
  expect(bench.asked).toEqual([]);
  expect(bench.turns[0]?.prompt).toBe("resolve the issue at https://example.sentry.io/issues/7746198397/");
  expect(out.actionable).toBe(true);
});

test("a ticket that attaches files never reaches Jev, and the turn opens them", async () => {
  const bench = harness({ values: [{ result: triaged }] });
  const ticket = "# Attached files\n\n/work/shot.png\n\nfix this";

  const out = await bench.run(ticket);

  expect(bench.tickets).toEqual([]);
  expect(bench.opens).toEqual([OPENS]);
  expect(bench.turns[0]?.prompt).toBe(ticket);
  expect(out.actionable).toBe(true);
});

test("a Jev that will not answer leaves the triage to the turn", async () => {
  const bench = harness({
    values: [{ result: triaged }],
    judged: [new Error("TypeSafe answered 500")],
  });

  const out = await bench.run("add a widget to the sidebar");

  expect(bench.opens).toEqual([OPENS]);
  expect(bench.asked).toEqual([]);
  expect(bench.shown[0]).toContain("TypeSafe answered 500");
  expect(out.branch).toBe("widget-sidebar-toggle");
});

test("what Jev finds missing goes to the person, and their words join the ticket", async () => {
  const bench = harness({
    values: [{ result: triaged }],
    answers: ["hide completed items"],
    judged: [VAGUE],
  });

  const out = await bench.run("add a widget to the sidebar");

  expect(bench.asked).toEqual([
    "The ticket is not ready to build: it says no outcome\n\nAdd what is missing, or stop.",
  ]);
  expect(bench.tickets).toEqual([
    "add a widget to the sidebar",
    "add a widget to the sidebar\n\n# Clarifications\n\nhide completed items",
  ]);
  expect(bench.opens).toEqual([READS]);
  expect(out.actionable).toBe(true);
});

test("a clarification carrying a link takes the ticket off Jev and onto the turn", async () => {
  const bench = harness({
    values: [{ result: triaged }],
    answers: ["it is the crash at https://example.sentry.io/issues/7746198397/"],
    judged: [VAGUE, POINTS],
  });

  await bench.run("fix the crash");

  expect(bench.opens).toEqual([OPENS]);
  expect(bench.turns[0]?.prompt).toBe(
    "fix the crash\n\n# Clarifications\n\nit is the crash at https://example.sentry.io/issues/7746198397/",
  );
});

test("a ticket the person will not clarify returns not actionable, and no session opens", async () => {
  const bench = harness({ answers: ["stop"], judged: [VAGUE] });

  const out = await bench.run("make it better");

  expect(out).toEqual({ actionable: false, reason: "it says no outcome", branch: "", tasks: [] });
  expect(bench.opens).toEqual([]);
  expect(bench.shown).toEqual(["not actionable: it says no outcome"]);
});

test("a turn that will not build the ticket returns not actionable", async () => {
  const bench = harness({
    values: [{ result: { ...triaged, actionable: false, reason: "it contradicts itself" } }],
    judged: [POINTS],
  });

  const out = await bench.run("make the link do the thing");

  expect(out.actionable).toBe(false);
  expect(bench.shown).toEqual(["not actionable: it contradicts itself"]);
});

test("blocked questions come back as answers on the same session", async () => {
  const bench = harness({
    values: [{ blocked: { questions: ["which sidebar?"] } }, { result: triaged }],
    answers: ["the left one"],
  });

  await bench.run("add a widget to the sidebar");

  expect(bench.asked).toEqual(["which sidebar?"]);
  expect(bench.turns.map((turn) => turn.session)).toEqual(["session-1", "session-1"]);
  expect(bench.turns[1]?.prompt).toBe("# Answers\n\nwhich sidebar?\nthe left one");
});

test("an answer holding neither result nor blocked goes back for one", async () => {
  const bench = harness({ values: [{}, { result: triaged }] });

  const out = await bench.run("add a widget to the sidebar");

  expect(bench.turns[1]?.prompt).toBe(
    "The answer held neither result nor blocked. Fill result with the triage.",
  );
  expect(out.branch).toBe("widget-sidebar-toggle");
});

test("a split the person will not take goes back as a revision", async () => {
  const two = { ...triaged, tasks: ["build the model", "build the screen"] };
  const bench = harness({
    values: [{ result: two }, { result: triaged }],
    answers: ["split it by layer instead"],
  });

  const out = await bench.run("add a widget to the sidebar");

  expect(out.tasks).toEqual(["build the model"]);
  expect(bench.turns[1]?.prompt).toBe(
    "# The revision the user asks for\n\nsplit it by layer instead",
  );
});

test("a turn that returns no task gets the ticket as the one task", async () => {
  const bench = harness({ values: [{ result: { ...triaged, tasks: [] } }] });

  const out = await bench.run("add a widget to the sidebar");

  expect(out.tasks).toEqual(["add a widget to the sidebar"]);
});
