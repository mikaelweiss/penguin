import { expect, test } from "bun:test";
import type { Ctx } from "penguin";
import work from "../examples/workflows/work.ts";

const RUN = Symbol.for("penguin.run");

type Turn = { session: string; skill: string; prompt: string };
type Child = { name: string; params: Record<string, unknown>; cwd?: string };

type Options = {
  tasks?: string[];
  actionable?: boolean;
  /** False leaves the project without a gate file, so the run settles them. */
  settled?: boolean;
  approved?: boolean;
  answer?: (question: string) => string;
};

function reply(question: string): string {
  if (question.includes("Try it.")) return "done";
  if (question.includes("approve keeps them")) return "approve";
  return "ok";
}

function harness(options: Options) {
  const asked: string[] = [];
  const turns: Turn[] = [];
  const children: Child[] = [];
  const sessions: string[] = [];
  const tasks = options.tasks ?? ["build the model", "build the screen"];
  const answer = options.answer ?? reply;
  let written = options.settled === false ? undefined : "bun test\n";

  const answers: Record<string, unknown> = {
    gates: { lines: ["bun test"] },
  };

  const agent = {
    open: () => {
      const session = `session-${sessions.length + 1}`;
      sessions.push(session);
      return Promise.resolve(session);
    },
    turn: (session: string, ask: { skill: string; prompt?: string }) => {
      turns.push({ session, skill: ask.skill, prompt: ask.prompt ?? "" });
      return {
        output: (async function* () {})(),
        value: Promise.resolve(answers[ask.skill] ?? {}),
      };
    },
  };

  const vcs = {
    fetch: () => Promise.resolve(),
    head: () => Promise.resolve({ branch: "main", sha: "f00d", detached: false }),
    worktree: {
      add: (name: string) => Promise.resolve({ existed: false, path: `/tmp/trees/${name}` }),
    },
  };

  const gates = {
    read: () => Promise.resolve(written),
    write: (text: string) => {
      written = text;
      return Promise.resolve();
    },
    run: () => Promise.resolve({ green: true, report: "bun test: pass" }),
  };

  const view = {
    show: () => Promise.resolve(),
    act: () => Promise.resolve(),
    ask: (question: string) => {
      asked.push(question);
      return Promise.resolve(answer(question));
    },
  };

  const hooks = {
    spawn: (file: string, params: Record<string, unknown>, cwd?: string) => {
      const name = file.split("/").pop() ?? file;
      children.push({ name, params, cwd });
      if (name === "triage.ts") {
        return Promise.resolve({
          actionable: options.actionable ?? true,
          reason: "the goal is one sentence",
          branch: "Widget Sidebar Toggle",
          tasks,
        });
      }
      if (name === "plan.ts") return Promise.resolve({ plan: "the plan", acceptance: "it works" });
      if (name === "implement.ts") {
        return Promise.resolve({
          approved: options.approved ?? true,
          blocking: options.approved === false ? "the error path is untested" : "",
        });
      }
      return Promise.resolve({ committed: true, message: "add the widget" });
    },
  };

  const params = work.params.parse({ ticket: "add a widget to the sidebar" });
  const ctx = { params, agent, vcs, gates, view, [RUN]: hooks } as unknown as Ctx<typeof params>;
  return { asked, turns, children, sessions, run: () => work.run(ctx) };
}

test("triage and every plan run as children, and the run itself opens no session", async () => {
  const run = harness({});

  await run.run();

  expect(run.children.map((child) => child.name)).toEqual([
    "triage.ts",
    "plan.ts",
    "implement.ts",
    "commit.ts",
    "plan.ts",
    "implement.ts",
    "commit.ts",
  ]);
  expect(run.turns).toEqual([]);
  expect(run.sessions).toEqual([]);
});

test("nothing names the branch: it comes back from triage, slugged", async () => {
  const run = harness({});

  const done = await run.run();

  expect(run.turns.some((turn) => turn.skill === "branch")).toBe(false);
  expect(done.branch).toBe("widget-sidebar-toggle");
  expect(done.path).toBe("/tmp/trees/widget-sidebar-toggle");
});

test("each plan is handed its task alone, as the ticket", async () => {
  const run = harness({});

  await run.run();

  const plans = run.children.filter((child) => child.name === "plan.ts");
  expect(plans.map((child) => child.params)).toEqual([
    { ticket: "build the model" },
    { ticket: "build the screen" },
  ]);
});

test("the shape ship and ship-local read comes back whole", async () => {
  const run = harness({ tasks: ["build the model"] });

  const done = await run.run();

  expect(done).toEqual({
    done: true,
    path: "/tmp/trees/widget-sidebar-toggle",
    branch: "widget-sidebar-toggle",
    acceptance: "it works",
    gates: "bun test: pass",
    from: "f00d",
    base: "main",
  });
});

test("a ticket nothing can be built from stops at an acknowledgement", async () => {
  const run = harness({ actionable: false });

  const done = await run.run();

  expect(done.done).toBe(false);
  expect(run.asked).toHaveLength(1);
  expect(run.asked[0]).toContain("Not actionable");
  expect(run.children.map((child) => child.name)).toEqual(["triage.ts"]);
});

test("the try gate asks once per task", async () => {
  const run = harness({});

  await run.run();

  expect(run.asked.filter((question) => question.includes("Try it."))).toHaveLength(2);
});

test("a review that did not approve is acknowledged before the try gate", async () => {
  const run = harness({ tasks: ["build the model"], approved: false });

  await run.run();

  expect(run.asked[0]).toContain("The review did not approve");
  expect(run.asked[1]).toContain("Try it.");
});

test("what the person asks for at the try gate is implemented and committed again", async () => {
  let tries = 0;
  const run = harness({
    tasks: ["build the model"],
    answer: (question) => {
      if (!question.includes("Try it.")) return reply(question);
      tries += 1;
      return tries === 1 ? "make the toggle green" : "done";
    },
  });

  await run.run();

  const tasks = run.children
    .filter((child) => child.name === "implement.ts")
    .map((child) => child.params["task"]);
  expect(tasks).toEqual(["the plan", "make the toggle green"]);
  expect(run.children.filter((child) => child.name === "commit.ts")).toHaveLength(2);
});

test("a project with no gate file settles them in a session of its own", async () => {
  const run = harness({ tasks: ["build the model"], settled: false });

  await run.run();

  expect(run.turns.map((turn) => turn.skill)).toEqual(["gates"]);
  expect(run.sessions).toEqual(["session-1"]);
});

test("the gate file a project already holds costs no turn", async () => {
  const run = harness({ tasks: ["build the model"] });

  await run.run();

  expect(run.turns.some((turn) => turn.skill === "gates")).toBe(false);
});

test("triage runs in the checkout, and every child after it in the worktree", async () => {
  const run = harness({ tasks: ["build the model"] });

  await run.run();

  expect(run.children.map((child) => child.cwd)).toEqual([
    undefined,
    "/tmp/trees/widget-sidebar-toggle",
    "/tmp/trees/widget-sidebar-toggle",
    "/tmp/trees/widget-sidebar-toggle",
  ]);
});
