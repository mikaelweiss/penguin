import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { latestTrace, run } from "./run.ts";
import { tracesDir } from "./paths.ts";

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

afterEach(() => {
  delete process.env["XDG_STATE_HOME"];
  delete process.env["PENGUIN_TEST_TALLY"];
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps = [];
});

test("wires the installed adapters onto ctx and runs the workflow", async () => {
  const { list, workflow } = catalog({ "adapters/echo.ts": ECHO, "workflows/hello.ts": HELLO });
  const result = await run(workflow, { name: "pip" }, { catalogs: list, trace: false });
  expect(result).toEqual({ ok: true, text: "hello pip" });
});

test("params that fail the schema refuse to run", async () => {
  const { list, workflow } = catalog({ "adapters/echo.ts": ECHO, "workflows/hello.ts": HELLO });
  await expect(run(workflow, {}, { catalogs: list, trace: false })).rejects.toThrow();
});

test("two implementations of one role refuse to run, naming both", async () => {
  const { list, workflow } = catalog({
    "adapters/echo.ts": ECHO,
    "adapters/echo2.ts": ECHO.replace('"test"', '"other"'),
    "workflows/hello.ts": HELLO,
  });
  await expect(run(workflow, { name: "pip" }, { catalogs: list, trace: false })).rejects.toThrow(
    /2 echo adapters/,
  );
});

test("a run leaves a trace of each adapter call", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-state-"));
  temps.push(state);
  process.env["XDG_STATE_HOME"] = state;
  const { list, workflow } = catalog({ "adapters/echo.ts": ECHO, "workflows/hello.ts": HELLO });
  await run(workflow, { name: "pip" }, { catalogs: list });
  const files = fs.readdirSync(tracesDir());
  expect(files.length).toBe(1);
  const first = files[0];
  if (first === undefined) throw new Error("no trace file");
  const written = fs.readFileSync(path.join(tracesDir(), first), "utf8");
  expect(written).toContain("echo.say");
  expect(written).toContain("hello pip");
  expect(written).toContain("elapsedMs");
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
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-state-"));
  temps.push(state);
  process.env["XDG_STATE_HOME"] = state;
  const tally = path.join(state, "tally");
  fs.writeFileSync(tally, "");
  process.env["PENGUIN_TEST_TALLY"] = tally;
  const { list, workflow } = catalog({ "adapters/echo.ts": COUNTING, "workflows/hello.ts": HELLO });
  await run(workflow, { name: "pip" }, { catalogs: list });
  const trace = latestTrace();
  if (trace === undefined) throw new Error("no trace file");
  expect(fs.readFileSync(tally, "utf8")).toBe("hello pip\n");
  const result = await run(workflow, { name: "pip" }, { catalogs: list, resume: trace });
  expect(result).toEqual({ ok: true, text: "hello pip" });
  expect(fs.readFileSync(tally, "utf8")).toBe("hello pip\n");
});

test("a trace of other params refuses to resume", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-state-"));
  temps.push(state);
  process.env["XDG_STATE_HOME"] = state;
  const { list, workflow } = catalog({ "adapters/echo.ts": ECHO, "workflows/hello.ts": HELLO });
  await run(workflow, { name: "pip" }, { catalogs: list });
  const trace = latestTrace();
  if (trace === undefined) throw new Error("no trace file");
  await expect(
    run(workflow, { name: "other" }, { catalogs: list, resume: trace }),
  ).rejects.toThrow(/not a trace/);
});
