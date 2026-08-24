import { beforeEach, afterEach, expect, test } from "bun:test";
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
  params: z.object({ name: z.string() }),
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
  params: z.object({ name: z.string() }),
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
  params: z.object({ name: z.string() }),
  async run(ctx) {
    const inner = await call(ctx, child, { name: ctx.params.name });
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
