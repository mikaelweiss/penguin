import { beforeEach, afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { latestRun, run } from "./run.ts";
import { runsDir } from "./paths.ts";

const ECHO = `import { adapter } from "penguin";
export default adapter({
  role: "echo",
  name: "test",
  description: "echoes back",
  build: () => ({
    async say(text: string) {
      return { ok: true, text };
    },
  }),
});
`;

const HELLO = `import { workflow } from "penguin";
import { z } from "zod";
type Echo = { say(text: string): Promise<{ ok: boolean; text: string }> };
export default workflow({
  description: "greets by echo",
  params: z.object({ name: z.string().describe("who to greet") }),
  async run(ctx) {
    const echo = (ctx as unknown as { echo: Echo }).echo;
    return echo.say("hello " + ctx.params.name);
  },
});
`;

let temps: string[] = [];

function catalog(files: Record<string, string>): {
  list: { dir: string; scope: "project" }[];
  workflow: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-run-"));
  temps.push(dir);
  fs.mkdirSync(path.join(dir, "adapters"));
  fs.mkdirSync(path.join(dir, "workflows"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return { list: [{ dir, scope: "project" }], workflow: path.join(dir, "workflows/hello.ts") };
}

beforeEach(() => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-state-"));
  temps.push(state);
  process.env["XDG_STATE_HOME"] = state;
});

afterEach(() => {
  delete process.env["XDG_STATE_HOME"];
  delete process.env["PENGUIN_HOME"];
  delete process.env["PENGUIN_TEST_TALLY"];
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps = [];
});

test("wires the installed adapters onto ctx and runs the workflow", async () => {
  const { list, workflow } = catalog({ "adapters/echo.ts": ECHO, "workflows/hello.ts": HELLO });
  const result = await run(workflow, { name: "pip" }, { catalogs: list });
  expect(result).toEqual({ ok: true, text: "hello pip" });
});

test("params that fail the schema refuse to run", async () => {
  const { list, workflow } = catalog({ "adapters/echo.ts": ECHO, "workflows/hello.ts": HELLO });
  await expect(run(workflow, {}, { catalogs: list })).rejects.toThrow();
});

test("two implementations of one role refuse to run, naming both", async () => {
  const { list, workflow } = catalog({
    "adapters/echo.ts": ECHO,
    "adapters/echo2.ts": ECHO.replace('"test"', '"other"'),
    "workflows/hello.ts": HELLO,
  });
  await expect(run(workflow, { name: "pip" }, { catalogs: list })).rejects.toThrow(
    /2 echo adapters/,
  );
});

const NEEDY = `import { workflow } from "penguin";
import { z } from "zod";
type Ledger = { write(text: string): Promise<void> };
export default workflow({
  description: "writes to a role nothing installs",
  params: z.object({ name: z.string().describe("who to greet") }),
  async run(ctx) {
    const ledger = (ctx as unknown as { ledger: Ledger }).ledger;
    await ledger.write(ctx.params.name);
  },
});
`;

test("a role nothing installed is named where the workflow reads it", async () => {
  const { list, workflow } = catalog({ "adapters/echo.ts": ECHO, "workflows/hello.ts": NEEDY });
  await expect(run(workflow, { name: "pip" }, { catalogs: list })).rejects.toThrow(
    /no ledger adapter is installed/,
  );
});

test("a run writes its file: head, each adapter call, and the outcome", async () => {
  const { list, workflow } = catalog({ "adapters/echo.ts": ECHO, "workflows/hello.ts": HELLO });
  await run(workflow, { name: "pip" }, { catalogs: list });
  const dirs = fs.readdirSync(runsDir());
  expect(dirs.length).toBe(1);
  const first = dirs[0];
  if (first === undefined) throw new Error("no run folder");
  const written = fs.readFileSync(path.join(runsDir(), first, "run.jsonl"), "utf8");
  expect(written).toContain('"pid"');
  expect(written).toContain('"root"');
  expect(written).toContain("echo.say");
  expect(written).toContain('"pending":true');
  expect(written).toContain("hello pip");
  expect(written).toContain("elapsedMs");
  expect(fs.existsSync(path.join(runsDir(), first, "inbox.jsonl"))).toBe(true);
});

const COUNTING = `import fs from "node:fs";
import { adapter } from "penguin";
export default adapter({
  role: "echo",
  name: "test",
  description: "echoes back and counts each call in a file",
  build: () => ({
    async say(text: string) {
      const tally = process.env["PENGUIN_TEST_TALLY"] ?? "";
      fs.appendFileSync(tally, text + "\\n");
      return { ok: true, text };
    },
  }),
});
`;

test("a resumed run replays recorded calls instead of repeating them", async () => {
  const tally = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "penguin-tally-")), "tally");
  temps.push(path.dirname(tally));
  fs.writeFileSync(tally, "");
  process.env["PENGUIN_TEST_TALLY"] = tally;
  const { list, workflow } = catalog({ "adapters/echo.ts": COUNTING, "workflows/hello.ts": HELLO });
  await run(workflow, { name: "pip" }, { catalogs: list });
  const previous = latestRun();
  if (previous === undefined) throw new Error("no run file");
  expect(fs.readFileSync(tally, "utf8")).toBe("hello pip\n");
  const result = await run(workflow, { name: "pip" }, { catalogs: list, resume: previous });
  expect(result).toEqual({ ok: true, text: "hello pip" });
  expect(fs.readFileSync(tally, "utf8")).toBe("hello pip\n");
});

const FLAKY = `import fs from "node:fs";
import { adapter, Fault } from "penguin";
export default adapter({
  role: "echo",
  name: "test",
  description: "faults on the first call ever, counts each attempt",
  build: () => ({
    async say(text: string) {
      const tally = process.env["PENGUIN_TEST_TALLY"] ?? "";
      const tried = fs.readFileSync(tally, "utf8");
      fs.appendFileSync(tally, text + "\\n");
      if (tried === "") throw new Fault("the world refused, once");
      return { ok: true, text };
    },
  }),
});
`;

/** Waits for an unanswered view.ask in any run's file, then answers it through that run's inbox. */
async function answerNext(answer: string): Promise<string> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const dirs = fs.existsSync(runsDir()) ? fs.readdirSync(runsDir()) : [];
    for (const dir of dirs) {
      const file = path.join(runsDir(), dir, "run.jsonl");
      if (!fs.existsSync(file)) continue;
      const entries = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const opens = entries.filter((e) => e["call"] === "view.ask" && e["pending"] === true);
      const closed = new Set(
        entries
          .filter((e) => e["call"] === "view.ask" && e["elapsedMs"] !== undefined)
          .map((e) => e["id"]),
      );
      const open = opens.find((e) => !closed.has(e["id"]));
      if (open !== undefined) {
        fs.appendFileSync(path.join(runsDir(), dir, "inbox.jsonl"), `${JSON.stringify({ answer })}\n`);
        return String((open["args"] as unknown[])[0]);
      }
    }
    if (Date.now() > deadline) throw new Error("no ask appeared");
    await Bun.sleep(25);
  }
}

test("a faulted call waits at the engine's gate, and a resume runs it again", async () => {
  const tally = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "penguin-tally-")), "tally");
  temps.push(path.dirname(tally));
  fs.writeFileSync(tally, "");
  process.env["PENGUIN_TEST_TALLY"] = tally;
  const { list, workflow } = catalog({ "adapters/echo.ts": FLAKY, "workflows/hello.ts": HELLO });

  // The fault holds the run at a gate. Stop ends the run on the fault itself.
  const first = run(workflow, { name: "pip" }, { catalogs: list });
  const gate = await answerNext("stop");
  expect(gate).toContain("echo.say failed");
  expect(gate).toContain("the world refused, once");
  await expect(first).rejects.toThrow("the world refused, once");

  const previous = latestRun();
  if (previous === undefined) throw new Error("no run file");
  const result = await run(workflow, { name: "pip" }, { catalogs: list, resume: previous });
  expect(result).toEqual({ ok: true, text: "hello pip" });
  expect(fs.readFileSync(tally, "utf8")).toBe("hello pip\nhello pip\n");
});

test("retry at the gate runs the faulted call again in place", async () => {
  const tally = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "penguin-tally-")), "tally");
  temps.push(path.dirname(tally));
  fs.writeFileSync(tally, "");
  process.env["PENGUIN_TEST_TALLY"] = tally;
  const { list, workflow } = catalog({ "adapters/echo.ts": FLAKY, "workflows/hello.ts": HELLO });

  const running = run(workflow, { name: "pip" }, { catalogs: list });
  await answerNext("retry");
  expect(await running).toEqual({ ok: true, text: "hello pip" });
  expect(fs.readFileSync(tally, "utf8")).toBe("hello pip\nhello pip\n");
});

const UNREADY = `import { adapter } from "penguin";
export default adapter({
  role: "echo",
  name: "test",
  description: "echoes back, but its preflight always objects",
  async check() {
    return ["the echo chamber is not installed"];
  },
  build: () => ({
    async say(text: string) {
      return { ok: true, text };
    },
  }),
});
`;

test("preflight holds a root run at a gate; skip runs anyway, and a child skips the checks", async () => {
  const { list, workflow } = catalog({ "adapters/echo.ts": UNREADY, "workflows/hello.ts": HELLO });

  const stopped = run(workflow, { name: "pip" }, { catalogs: list });
  const gate = await answerNext("stop");
  expect(gate).toContain("the echo chamber is not installed");
  await expect(stopped).rejects.toThrow("the run cannot start");

  const skipped = run(workflow, { name: "pip" }, { catalogs: list });
  await answerNext("skip");
  expect(await skipped).toEqual({ ok: true, text: "hello pip" });

  // A child works where its parent already checked, so its own preflight never runs.
  const asChild = await run(workflow, { name: "pip" }, { catalogs: list, parent: "someone" });
  expect(asChild).toEqual({ ok: true, text: "hello pip" });
});

test("a run file of other params refuses to resume", async () => {
  const { list, workflow } = catalog({ "adapters/echo.ts": ECHO, "workflows/hello.ts": HELLO });
  await run(workflow, { name: "pip" }, { catalogs: list });
  const previous = latestRun();
  if (previous === undefined) throw new Error("no run file");
  await expect(
    run(workflow, { name: "other" }, { catalogs: list, resume: previous }),
  ).rejects.toThrow(/not a run/);
});

const CHILD = `import { workflow } from "penguin";
import { z } from "zod";
type Echo = { say(text: string): Promise<{ ok: boolean; text: string }> };
export default workflow({
  description: "greets from a sub-run",
  params: z.object({ name: z.string().describe("who to greet") }),
  async run(ctx) {
    const echo = (ctx as unknown as { echo: Echo }).echo;
    return echo.say("hi " + ctx.params.name);
  },
});
`;

const PARENT = `import { call, workflow } from "penguin";
import { z } from "zod";
import child from "./child.ts";
export default workflow({
  description: "spawns a child run",
  params: z.object({ name: z.string().describe("who to greet") }),
  async run(ctx) {
    const inner = await call(ctx, child, { name: ctx.params.name });
    return { inner };
  },
});
`;

const PARENT_AT = `import { call, workflow } from "penguin";
import { z } from "zod";
import child from "./child.ts";
export default workflow({
  description: "spawns a child run in a folder of its own",
  params: z.object({
    name: z.string().describe("who to greet"),
    at: z.string().describe("where the child runs"),
  }),
  async run(ctx) {
    const inner = await call(ctx, child, { name: ctx.params.name }, { cwd: ctx.params.at });
    return { inner };
  },
});
`;

test("call spawns the child as its own run and hands back its outcome", async () => {
  const { list, workflow } = catalog({
    "adapters/echo.ts": ECHO,
    "workflows/hello.ts": PARENT,
    "workflows/child.ts": CHILD,
  });
  const result = await run(workflow, { name: "pip" }, { catalogs: list });
  expect(result).toEqual({ inner: { ok: true, text: "hi pip" } });
  const dirs = fs.readdirSync(runsDir());
  expect(dirs.length).toBe(2);
  const heads = dirs.map((dir) => {
    const line = fs.readFileSync(path.join(runsDir(), dir, "run.jsonl"), "utf8").split("\n")[0];
    return JSON.parse(line ?? "{}") as Record<string, unknown>;
  });
  const child = heads.find((head) => head["parent"] !== undefined);
  const parent = heads.find((head) => head["parent"] === undefined);
  expect(child?.["parent"]).toBe(parent?.["run"]);
}, 20000);

test("a child takes the folder call names, resolved against the parent's", async () => {
  const { list, workflow } = catalog({
    "adapters/echo.ts": ECHO,
    "workflows/hello.ts": PARENT_AT,
    "workflows/child.ts": CHILD,
  });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-base-"));
  temps.push(base);
  fs.mkdirSync(path.join(base, "sub"));

  await run(workflow, { name: "pip", at: "sub" }, { catalogs: list, cwd: base });

  const heads = fs.readdirSync(runsDir()).map((dir) => {
    const line = fs.readFileSync(path.join(runsDir(), dir, "run.jsonl"), "utf8").split("\n")[0];
    return JSON.parse(line ?? "{}") as Record<string, unknown>;
  });
  const child = heads.find((head) => head["parent"] !== undefined);
  const parent = heads.find((head) => head["parent"] === undefined);
  expect(parent?.["cwd"]).toBe(base);
  expect(child?.["cwd"]).toBe(path.join(base, "sub"));
}, 20000);

function git(cwd: string, args: string[]): void {
  const done = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (done.status !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr}`);
}

/** A repository holding one commit, so a checkout can be cut from it. */
function repository(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-repo-"));
  temps.push(dir);
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "penguin@test"]);
  git(dir, ["config", "user.name", "penguin"]);
  fs.writeFileSync(path.join(dir, "readme.md"), "a repository\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "first"]);
  return dir;
}

/** The catalog files a checkout carries, written where that checkout's runs will look. */
function stock(checkout: string, files: Record<string, string>): string {
  const home = path.join(checkout, ".penguin");
  fs.mkdirSync(path.join(home, "adapters"), { recursive: true });
  fs.mkdirSync(path.join(home, "workflows"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(home, name), content);
  }
  return path.join(home, "workflows/hello.ts");
}

/** A sibling checkout of root, on a branch of its own. */
function sibling(root: string, name: string): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "penguin-branch-")), name);
  temps.push(path.dirname(dir));
  git(root, ["worktree", "add", "-b", name, dir]);
  return dir;
}

/** A home of its own, so the user's real catalogs stay out of the run. */
function bare(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-home-"));
  temps.push(dir);
  process.env["PENGUIN_HOME"] = dir;
}

function head(): Record<string, unknown> {
  const dirs = fs.readdirSync(runsDir());
  const first = dirs[0];
  if (dirs.length !== 1 || first === undefined) throw new Error("no single run folder");
  const line = fs.readFileSync(path.join(runsDir(), first, "run.jsonl"), "utf8").split("\n")[0];
  return JSON.parse(line ?? "{}") as Record<string, unknown>;
}

test("a workflow a sibling checkout holds runs in that checkout, with its adapters", async () => {
  bare();
  const root = repository();
  const checkout = sibling(root, "feature");
  const workflow = stock(checkout, { "adapters/echo.ts": ECHO, "workflows/hello.ts": HELLO });

  // Only the branch has an echo adapter, so an answer at all is the branch's catalog answering.
  const result = await run(workflow, { name: "pip" }, { cwd: root });

  expect(result).toEqual({ ok: true, text: "hello pip" });
  expect(head()["cwd"]).toBe(fs.realpathSync(checkout));
  expect(head()["root"]).toBe(fs.realpathSync(root));
});

test("a workflow the run's own checkout holds stays where the run started", async () => {
  bare();
  const root = repository();
  sibling(root, "feature");
  const workflow = stock(root, { "adapters/echo.ts": ECHO, "workflows/hello.ts": HELLO });

  const result = await run(workflow, { name: "pip" }, { cwd: root });

  expect(result).toEqual({ ok: true, text: "hello pip" });
  expect(head()["cwd"]).toBe(root);
});

const AGENT = `import { adapter } from "penguin";
export default adapter({
  role: "agent",
  name: "NAME",
  description: "a stand-in agent whose session id names it",
  build: () => ({
    async open() {
      return "NAME-session";
    },
    turn: (session) => ({ output: [], value: Promise.resolve(session) }),
    async stop() {},
  }),
});
`;

const UNREADY_AGENT = AGENT.replace(
  "  build:",
  `  async check() {
    return ["two is not installed or not on PATH."];
  },
  build:`,
);

const NAMES = `import { workflow } from "penguin";
import { z } from "zod";
type Agent = { open(options?: { adapter?: string }): Promise<string> };
export default workflow({
  description: "opens a session on the agent adapter it was told to name",
  params: z.object({ adapter: z.string().describe("which agent adapter runs the session") }),
  async run(ctx) {
    const agent = (ctx as unknown as { agent: Agent }).agent;
    return agent.open({ adapter: ctx.params.adapter });
  },
});
`;

/** Two agent adapters with a config line choosing the first, the shape routing needs. */
function agents(second: string): { list: { dir: string; scope: "project" }[]; workflow: string } {
  bare();
  fs.writeFileSync(path.join(process.env["PENGUIN_HOME"] ?? "", "config"), "agent one\n");
  return catalog({
    "adapters/one.ts": AGENT.replaceAll("NAME", "one"),
    "adapters/two.ts": second.replaceAll("NAME", "two"),
    "workflows/hello.ts": NAMES,
  });
}

function notes(): Record<string, unknown>[] {
  const dirs = fs.readdirSync(runsDir());
  const first = dirs[0];
  if (first === undefined) throw new Error("no run folder");
  return fs
    .readFileSync(path.join(runsDir(), first, "run.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("a workflow names the agent adapter its session runs on", async () => {
  const { list, workflow } = agents(AGENT);
  expect(await run(workflow, { adapter: "two" }, { catalogs: list })).toBe("two-session");
});

test("a named agent adapter that is not ready falls back, and never blocks the run", async () => {
  const { list, workflow } = agents(UNREADY_AGENT);

  // Nothing gates the run: only the configured adapter is preflighted, and the fallback is silent
  // to the workflow, so this settles without an answer from anyone.
  expect(await run(workflow, { adapter: "two" }, { catalogs: list })).toBe("one-session");

  const told = notes().find((note) => note["fallback"] !== undefined);
  expect(told?.["fallback"]).toEqual({
    role: "agent",
    wanted: "two",
    used: "one",
    reason: "two is not installed or not on PATH.",
  });
});
