import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Ctx } from "penguin";
import { NOTES_ASK, Notes } from "../examples/helpers/brief.ts";
import { bearings, type Bearings } from "../examples/helpers/discover.ts";
import plan from "../examples/workflows/plan.ts";

type Turn = { session: string; skill: string | undefined; prompt: string };
type Opened = Record<string, unknown>;
type Rendered = {
  html: string;
  md: string;
  png: string | null;
  version: number;
  problems: string[];
};

const PAGE: Rendered = {
  html: "/briefs/proposal.html",
  md: "/briefs/proposal.md",
  png: "/briefs/proposal.png",
  version: 1,
  problems: [],
};
const REFUSED: Rendered = { html: "", md: "", png: null, version: 0, problems: ["title: missing"] };

let temps: string[] = [];

afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps = [];
});

/** The scout answers the first turn, so every list of values starts with what it found. */
function harness(values: unknown[], answers: string[], renders: Rendered[] = []) {
  const asked: string[] = [];
  const shapes: unknown[] = [];
  const turns: Turn[] = [];
  const opens: Opened[] = [];
  const wheres: { name: string; branch?: string }[] = [];
  const shown: { html: string; version: number }[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-plan-briefs-"));
  temps.push(dir);
  const json = path.join(dir, "proposal.json");
  let rendered = 0;
  const view = {
    show: () => Promise.resolve(),
    act: () => Promise.resolve(),
    ask: (question: string, shape?: unknown) => {
      asked.push(question);
      shapes.push(shape);
      return Promise.resolve(answers[asked.length - 1] ?? "approve");
    },
  };
  const agent = {
    open: (options?: Opened) => {
      opens.push(options ?? {});
      return Promise.resolve(`session-${opens.length}`);
    },
    turn: (session: string, ask: string | { skill?: string; prompt?: string }) => {
      const said = typeof ask === "string" ? { prompt: ask } : ask;
      turns.push({ session, skill: said.skill, prompt: said.prompt ?? "" });
      // A brief turn writes the JSON, which is what tells the next one that the numbers stand.
      if (said.skill === "brief") fs.writeFileSync(json, "{}");
      return {
        output: (async function* () {})(),
        value: Promise.resolve(values[turns.length - 1] ?? {}),
      };
    },
  };
  const brief = {
    where: (options: { name: string; branch?: string }) => {
      wheres.push(options);
      return Promise.resolve(path.join(dir, `${options.name}.json`));
    },
    render: () => {
      rendered += 1;
      return Promise.resolve(renders[rendered - 1] ?? { ...PAGE, version: rendered });
    },
    open: (html: string, version: number) => {
      shown.push({ html, version });
      return Promise.resolve();
    },
  };
  const ctx = { agent, brief, view } as unknown as Ctx<unknown>;
  return {
    asked,
    shapes,
    turns,
    opens,
    wheres,
    shown,
    json,
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

/** What the proposal page's Copy notes button writes, version and markdown list and all. */
function notes(body: string): string {
  return `---\n## Notes from "the plan" v1\n${body}\n---`;
}

test("the scout finds the files first, and the planner is handed them with the task", async () => {
  const bench = harness([scouted, planned], []);

  const out = await bench.run("build the model");

  expect(out.acceptance).toBe("it works");
  expect(bench.opens[0]).toMatchObject({ model: "small" });
  expect(bench.opens[1]).toEqual({});
  expect(bench.turns.map((turn) => turn.session)).toEqual(["session-1", "session-2", "session-2"]);
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

  expect(bench.turns.slice(1).map((turn) => turn.session)).toEqual([
    "session-2",
    "session-2",
    "session-2",
  ]);
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

test("a plan the person will not approve goes back as a revision against the page", async () => {
  const bench = harness([scouted, planned, {}, planned], ["keep the migration out of it"]);

  const out = await bench.run("build the model");

  expect(out.plan).toBe("the plan");
  expect(bench.turns[3]?.prompt).toBe(
    "# The revision the user asks for, numbered against the proposal page\n\nkeep the migration out of it",
  );
});

test("with no page to number against, the revision heading says only that", async () => {
  const bench = harness(
    [scouted, planned, {}, {}, {}, planned],
    ["keep the migration out of it"],
    [REFUSED, REFUSED, REFUSED],
  );

  await bench.run("build the model");

  expect(bench.turns[5]?.prompt).toBe(
    "# The revision the user asks for\n\nkeep the migration out of it",
  );
});

test("the plan goes to the brief on the planner's session, with the path and the mode", async () => {
  const bench = harness([scouted, planned], []);

  await bench.run("build the model");

  expect(bench.wheres[0]?.name).toBe("proposal");
  expect(bench.turns[2]?.session).toBe("session-2");
  expect(bench.turns[2]?.skill).toBe("brief");
  expect(bench.turns[2]?.prompt).toContain(bench.json);
  expect(bench.turns[2]?.prompt).toContain("proposal brief");
  expect(bench.turns[2]?.prompt).toContain("the plan");
  expect(bench.shown).toEqual([{ html: "/briefs/proposal.html", version: 1 }]);
  expect(bench.asked[0]).toBe(NOTES_ASK);
  // The shape is what gives the app its approve choice: a bare ask builds no menu.
  expect(bench.shapes[0]).toBe(Notes);
});

test("a refused brief goes back with the problems, and the text gate stands in", async () => {
  const bench = harness([scouted, planned], [], [REFUSED, REFUSED, REFUSED]);

  const out = await bench.run("build the model");

  expect(out.plan).toBe("the plan");
  expect(bench.turns).toHaveLength(5);
  expect(bench.turns[3]?.prompt).toContain("title: missing");
  expect(bench.turns[4]?.prompt).toContain("title: missing");
  expect(bench.shown).toEqual([]);
  expect(bench.asked[0]).toBe("the plan\n\nApprove the plan?");
});

test("a notes block that ticks every number approves the plan", async () => {
  const bench = harness([scouted, planned], [notes("- 3.\n- 5. ok")]);

  const out = await bench.run("build the model");

  expect(out.plan).toBe("the plan");
  expect(bench.turns).toHaveLength(3);
});

test("an untouched page approves the plan", async () => {
  const bench = harness([scouted, planned], [notes("No notes, all approved")]);

  await bench.run("build the model");

  expect(bench.turns).toHaveLength(3);
});

test("a notes block with a change becomes the revision, and the next page keeps its numbers", async () => {
  const reply = notes("- 5. use the existing helper instead");
  const bench = harness([scouted, planned, {}, planned], [reply]);

  await bench.run("build the model");

  expect(bench.turns[3]?.prompt).toBe(
    "# The revision the user asks for, numbered against the proposal page\n\n- 5. use the existing helper instead",
  );
  expect(bench.turns[4]?.skill).toBe("brief");
  expect(bench.turns[4]?.prompt).toContain("keeps the number it has");
  expect(bench.turns[4]?.prompt).toContain(reply);
  expect(bench.shown).toEqual([
    { html: "/briefs/proposal.html", version: 1 },
    { html: "/briefs/proposal.html", version: 2 },
  ]);
});
