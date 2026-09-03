import { beforeEach, afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunPaused } from "./core/errors.ts";
import { isClosing, lastSegment } from "./core/segments.ts";
import { run, runId, signalChildren } from "./run.ts";
import { runDir, runsDir } from "./paths.ts";
import { readEntries, runFile } from "./trace.ts";

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
  expect(fs.readFileSync(path.join(runsDir(), first, "pid"), "utf8")).toBe(String(process.pid));
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

/** A file every call appends to, so a test can count what ran across processes and resumes. */
function tallyFile(): string {
  const tally = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "penguin-tally-")), "tally");
  temps.push(path.dirname(tally));
  fs.writeFileSync(tally, "");
  process.env["PENGUIN_TEST_TALLY"] = tally;
  return tally;
}

function isHead(entry: Record<string, unknown>): boolean {
  return entry["call"] === undefined && "run" in entry && "workflow" in entry;
}

const ASKING = `import { workflow } from "penguin";
import { z } from "zod";
type Echo = { say(text: string): Promise<{ ok: boolean; text: string }> };
type Asker = { ask(question: string): Promise<unknown> };
export default workflow({
  description: "asks what to say, then says it",
  params: z.object({ name: z.string().describe("who to greet") }),
  async run(ctx) {
    const echo = (ctx as unknown as { echo: Echo }).echo;
    const view = (ctx as unknown as { view: Asker }).view;
    const answer = await view.ask("What do I say to " + ctx.params.name + "?");
    return echo.say(String(answer));
  },
});
`;

test("a resume keeps the person's answer and reads the world again", async () => {
  const tally = tallyFile();
  const { list, workflow } = catalog({ "adapters/echo.ts": COUNTING, "workflows/hello.ts": ASKING });
  const id = runId();
  const first = run(workflow, { name: "pip" }, { catalogs: list, id });
  expect(await answerNext("hi")).toBe("What do I say to pip?");
  expect(await first).toEqual({ ok: true, text: "hi" });
  expect(fs.readFileSync(tally, "utf8")).toBe("hi\n");

  const again = await run(workflow, { name: "pip" }, { catalogs: list, id, resume: true });

  expect(again).toEqual({ ok: true, text: "hi" });
  expect(fs.readFileSync(tally, "utf8")).toBe("hi\nhi\n");
  const entries = readEntries(runFile(id));
  expect(entries.filter(isHead)).toHaveLength(2);
  expect(entries.filter((e) => e["call"] === "view.ask" && e["pending"] === true)).toHaveLength(1);
  expect(entries.findLast((e) => e["call"] === "view.ask")?.["replayed"]).toBe(true);
});

const TALKING = `import fs from "node:fs";
import { adapter } from "penguin";
export default adapter({
  role: "agent",
  name: "test",
  description: "an agent whose turns count themselves",
  build: () => ({
    async open() {
      return "s1";
    },
    turn(session: string, ask: string) {
      const tally = process.env["PENGUIN_TEST_TALLY"] ?? "";
      const output = (async function* () {
        yield { kind: "text", text: "said" };
      })();
      const value = (async () => {
        fs.appendFileSync(tally, "turn\\n");
        return { n: 7 };
      })();
      return { output, value };
    },
    async stop() {},
  }),
});
`;

const TURNING = `import { workflow } from "penguin";
import { z } from "zod";
type Echo = { say(text: string): Promise<{ ok: boolean; text: string }> };
type Turn = { output: AsyncIterable<{ text: string }>; value: Promise<{ n: number }> };
type Agent = { open(): Promise<string>; turn(session: string, ask: string): Turn };
export default workflow({
  description: "runs one turn and says what it heard",
  params: z.object({ name: z.string().describe("who to greet") }),
  async run(ctx) {
    const echo = (ctx as unknown as { echo: Echo }).echo;
    const agent = (ctx as unknown as { agent: Agent }).agent;
    const session = await agent.open();
    const turn = agent.turn(session, "go");
    const heard: string[] = [];
    for await (const chunk of turn.output) heard.push(chunk.text);
    const value = await turn.value;
    return echo.say(heard.join("") + ":" + value.n);
  },
});
`;

test("a resume hands a finished turn its value back, with nothing left to stream", async () => {
  bare();
  const tally = tallyFile();
  const { list, workflow } = catalog({
    "adapters/echo.ts": COUNTING,
    "adapters/agent.ts": TALKING,
    "workflows/hello.ts": TURNING,
  });
  const id = runId();
  expect(await run(workflow, { name: "pip" }, { catalogs: list, id })).toEqual({
    ok: true,
    text: "said:7",
  });
  expect(fs.readFileSync(tally, "utf8")).toBe("turn\nsaid:7\n");

  const again = await run(workflow, { name: "pip" }, { catalogs: list, id, resume: true });

  expect(again).toEqual({ ok: true, text: ":7" });
  expect(fs.readFileSync(tally, "utf8")).toBe("turn\nsaid:7\n:7\n");
});

const ASKING_MORE = `import fs from "node:fs";
import { workflow } from "penguin";
import { z } from "zod";
type Echo = { say(text: string): Promise<{ ok: boolean; text: string }> };
type Asker = { ask(question: string): Promise<unknown> };
export default workflow({
  description: "asks once, and once more when a marker file says so",
  params: z.object({ name: z.string().describe("who to greet") }),
  async run(ctx) {
    const echo = (ctx as unknown as { echo: Echo }).echo;
    const view = (ctx as unknown as { view: Asker }).view;
    const first = await view.ask("What do I say to " + ctx.params.name + "?");
    if (!fs.existsSync(process.env["PENGUIN_TEST_TALLY"] + ".more")) return echo.say(String(first));
    const second = await view.ask("And then?");
    return echo.say(first + " " + second);
  },
});
`;

test("a resume leaves the earlier segment's answers behind and waits on a new ask", async () => {
  const tally = tallyFile();
  const { list, workflow } = catalog({
    "adapters/echo.ts": COUNTING,
    "workflows/hello.ts": ASKING_MORE,
  });
  const id = runId();
  const first = run(workflow, { name: "pip" }, { catalogs: list, id });
  expect(await answerNext("hi")).toBe("What do I say to pip?");
  expect(await first).toEqual({ ok: true, text: "hi" });

  fs.writeFileSync(`${tally}.more`, "");
  const again = run(workflow, { name: "pip" }, { catalogs: list, id, resume: true });

  expect(await answerNext("bye")).toBe("And then?");
  expect(await again).toEqual({ ok: true, text: "hi bye" });
});

const STOPPING = `import { workflow } from "penguin";
import { z } from "zod";
type Echo = { say(text: string): Promise<{ ok: boolean; text: string }> };
type Asker = { ask(question: string): Promise<unknown> };
type Agent = { open(): Promise<string>; stop(session: string): Promise<void> };
export default workflow({
  description: "stops an agent, then asks",
  params: z.object({ name: z.string().describe("who to greet") }),
  async run(ctx) {
    const echo = (ctx as unknown as { echo: Echo }).echo;
    const view = (ctx as unknown as { view: Asker }).view;
    const agent = (ctx as unknown as { agent: Agent }).agent;
    await agent.stop(await agent.open());
    const answer = await view.ask("What do I say to " + ctx.params.name + "?");
    return echo.say(String(answer));
  },
});
`;

test("a remembered call that settles with nothing still replays, and so does what follows it", async () => {
  bare();
  tallyFile();
  const { list, workflow } = catalog({
    "adapters/echo.ts": COUNTING,
    "adapters/agent.ts": TALKING,
    "workflows/hello.ts": STOPPING,
  });
  const id = runId();
  const first = run(workflow, { name: "pip" }, { catalogs: list, id });
  expect(await answerNext("hi")).toBe("What do I say to pip?");
  expect(await first).toEqual({ ok: true, text: "hi" });
  const stopped = readEntries(runFile(id)).find(
    (e) => e["call"] === "agent.stop" && e["pending"] !== true,
  );
  expect(stopped?.["outcome"]).toBeNull();

  const again = await run(workflow, { name: "pip" }, { catalogs: list, id, resume: true });

  expect(again).toEqual({ ok: true, text: "hi" });
  const entries = readEntries(runFile(id));
  expect(entries.filter((e) => e["call"] === "view.ask" && e["pending"] === true)).toHaveLength(1);
  expect(entries.findLast((e) => e["call"] === "agent.stop")?.["replayed"]).toBe(true);
  expect(entries.findLast((e) => e["call"] === "view.ask")?.["replayed"]).toBe(true);
});

test("a resume refuses a run whose process is still writing", async () => {
  const { list, workflow } = catalog({ "adapters/echo.ts": ECHO, "workflows/hello.ts": HELLO });
  const id = runId();
  const head = { at: "t", run: id, workflow, params: { name: "pip" }, cwd: "/", root: "/" };
  fs.writeFileSync(runFile(id), `${JSON.stringify(head)}\n`);
  fs.writeFileSync(path.join(runDir(id), "pid"), String(process.pid));

  await expect(
    run(workflow, { name: "pip" }, { catalogs: list, id, resume: true }),
  ).rejects.toThrow(/still running/);
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
      const entries = lastSegment(
        fs
          .readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      );
      if (entries.some(isClosing)) continue;
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
  const tally = tallyFile();
  const { list, workflow } = catalog({ "adapters/echo.ts": FLAKY, "workflows/hello.ts": HELLO });
  const id = runId();

  // The fault holds the run at a gate. Stop ends the run on the fault itself.
  const first = run(workflow, { name: "pip" }, { catalogs: list, id });
  const gate = await answerNext("stop");
  expect(gate).toContain("echo.say failed");
  expect(gate).toContain("the world refused, once");
  await expect(first).rejects.toThrow("the world refused, once");

  const result = await run(workflow, { name: "pip" }, { catalogs: list, id, resume: true });
  expect(result).toEqual({ ok: true, text: "hello pip" });
  expect(fs.readFileSync(tally, "utf8")).toBe("hello pip\nhello pip\n");
});

test("retry at the gate runs the faulted call again in place", async () => {
  const tally = tallyFile();
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
  const id = runId();
  await run(workflow, { name: "pip" }, { catalogs: list, id });
  await expect(
    run(workflow, { name: "other" }, { catalogs: list, id, resume: true }),
  ).rejects.toThrow(/not a run/);
});

const PAUSING = `import fs from "node:fs";
import { RunPaused, workflow } from "penguin";
import { z } from "zod";
export default workflow({
  description: "hits a limit the first time, greets the second",
  params: z.object({ name: z.string().describe("who to greet") }),
  async run(ctx) {
    const tally = process.env["PENGUIN_TEST_TALLY"] ?? "";
    const before = fs.readFileSync(tally, "utf8");
    fs.appendFileSync(tally, "child\\n");
    if (before === "") {
      throw new RunPaused("resets at three", { by: "limit", until: "2026-09-02T15:00:00.000Z" });
    }
    return { ok: true, text: "hi " + ctx.params.name };
  },
});
`;

test("a child's limit pauses the tree, and resuming the parent resumes the child in place", async () => {
  const tally = tallyFile();
  const { list, workflow } = catalog({
    "adapters/echo.ts": ECHO,
    "workflows/hello.ts": PARENT,
    "workflows/child.ts": PAUSING,
  });
  const id = runId();
  const paused = { by: "limit", reason: "resets at three", until: "2026-09-02T15:00:00.000Z" };

  await expect(run(workflow, { name: "pip" }, { catalogs: list, id })).rejects.toBeInstanceOf(
    RunPaused,
  );

  const child = runFile(`${id}-c1`);
  expect(readEntries(runFile(id)).findLast((e) => "paused" in e)?.["paused"]).toEqual(paused);
  expect(readEntries(child).findLast((e) => "paused" in e)?.["paused"]).toEqual(paused);

  const result = await run(workflow, { name: "pip" }, { catalogs: list, id, resume: true });

  expect(result).toEqual({ inner: { ok: true, text: "hi pip" } });
  expect(fs.readFileSync(tally, "utf8")).toBe("child\nchild\n");
  expect(fs.readdirSync(runsDir()).sort()).toEqual([id, `${id}-c1`]);
  expect(readEntries(child).filter(isHead)).toHaveLength(2);
  const spawns = readEntries(runFile(id)).filter((e) => e["call"] === "run" && e["pending"] === true);
  expect(spawns.map((e) => e["id"])).toEqual(["c1", "c2"]);
}, 20000);

const ERRORING = `import { RunPaused, workflow } from "penguin";
import { z } from "zod";
export default workflow({
  description: "stops on an error no retry clears",
  params: z.object({ name: z.string().describe("who to greet") }),
  async run() {
    throw new RunPaused("API Error: 500", { by: "error" });
  },
});
`;

test("a child's error pause reaches the parent as one, not as a person's", async () => {
  const { list, workflow } = catalog({
    "adapters/echo.ts": ECHO,
    "workflows/hello.ts": PARENT,
    "workflows/child.ts": ERRORING,
  });
  const id = runId();
  const paused = { by: "error", reason: "API Error: 500" };

  await expect(run(workflow, { name: "pip" }, { catalogs: list, id })).rejects.toBeInstanceOf(
    RunPaused,
  );

  expect(readEntries(runFile(id)).findLast((e) => "paused" in e)?.["paused"]).toEqual(paused);
  expect(readEntries(runFile(`${id}-c1`)).findLast((e) => "paused" in e)?.["paused"]).toEqual(
    paused,
  );
}, 20000);

function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (check()) resolve();
      else if (Date.now() > deadline) reject(new Error("waited too long"));
      else setTimeout(tick, 25);
    };
    tick();
  });
}

function closed(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => child.on("close", resolve));
}

test("an interrupt parks a run process, and the same folder takes it up again", async () => {
  tallyFile();
  const { list, workflow } = catalog({ "adapters/echo.ts": COUNTING, "workflows/hello.ts": ASKING });
  const entry = fileURLToPath(new URL("./child.ts", import.meta.url));
  const id = runId();
  const job = { id, file: workflow, params: { name: "pip" }, cwd: os.tmpdir(), catalogs: list };

  const first = spawn(process.execPath, [entry, JSON.stringify(job)], { stdio: "ignore" });
  await waitFor(() =>
    readEntries(runFile(id)).some((e) => e["call"] === "view.ask" && e["pending"] === true),
  );
  first.kill("SIGINT");
  expect(await closed(first)).toBe(130);
  expect(readEntries(runFile(id)).findLast((e) => "paused" in e)?.["paused"]).toEqual({ by: "user" });

  const again = spawn(process.execPath, [entry, JSON.stringify({ id, resume: true })], {
    stdio: "ignore",
  });
  expect(await answerNext("hi")).toBe("What do I say to pip?");
  expect(await closed(again)).toBe(0);
  const entries = readEntries(runFile(id));
  expect(entries.filter(isHead)).toHaveLength(2);
  expect(entries.findLast((e) => "outcome" in e && e["call"] === undefined)?.["outcome"]).toEqual({
    ok: true,
    text: "hi",
  });
}, 20000);

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

test("a parent that attaches to a live child still passes a pause down to it", async () => {
  tallyFile();
  const { list, workflow } = catalog({
    "adapters/echo.ts": COUNTING,
    "workflows/hello.ts": PARENT,
    "workflows/child.ts": ASKING,
  });
  const entry = fileURLToPath(new URL("./child.ts", import.meta.url));
  const id = runId();
  const child = `${id}-c1`;
  const job = { id, file: workflow, params: { name: "pip" }, cwd: os.tmpdir(), catalogs: list };

  const first = spawn(process.execPath, [entry, JSON.stringify(job)], { stdio: "ignore" });
  await waitFor(() =>
    fs.existsSync(runFile(child)) &&
    readEntries(runFile(child)).some((e) => e["call"] === "view.ask" && e["pending"] === true),
  );
  // The parent dies without a word. Its child, leading its own group, goes on waiting.
  first.kill("SIGKILL");
  await closed(first);

  const again = run(workflow, { name: "pip" }, { catalogs: list, cwd: os.tmpdir(), id, resume: true });
  await waitFor(() => readEntries(runFile(id)).filter(isHead).length === 2);
  await waitFor(() => lastSegment(readEntries(runFile(id))).some((e) => e["child"] === child));
  signalChildren("SIGINT");

  await expect(again).rejects.toBeInstanceOf(RunPaused);
  expect(readEntries(runFile(child)).findLast((e) => "paused" in e)?.["paused"]).toEqual({
    by: "user",
  });
  expect(fs.readdirSync(runsDir()).sort()).toEqual([id, child]);
}, 20000);

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

test("a resume that dies in setup keeps the memory of the segment before it", async () => {
  const tally = tallyFile();
  const { list, workflow } = catalog({ "adapters/echo.ts": COUNTING, "workflows/hello.ts": ASKING });
  const id = runId();
  const first = run(workflow, { name: "pip" }, { catalogs: list, id });
  await answerNext("hi");
  expect(await first).toEqual({ ok: true, text: "hi" });

  // A second echo adapter makes the role ambiguous, so the resume dies wiring ctx.
  const extra = path.join(path.dirname(path.dirname(workflow)), "adapters", "echo2.ts");
  fs.writeFileSync(extra, ECHO.replace('"test"', '"other"'));
  await expect(
    run(workflow, { name: "pip" }, { catalogs: list, id, resume: true }),
  ).rejects.toThrow(/2 echo adapters/);
  fs.unlinkSync(extra);

  const again = await run(workflow, { name: "pip" }, { catalogs: list, id, resume: true });

  expect(again).toEqual({ ok: true, text: "hi" });
  expect(fs.readFileSync(tally, "utf8")).toBe("hi\nhi\n");
  const entries = readEntries(runFile(id));
  expect(entries.filter(isHead)).toHaveLength(3);
  expect(entries.filter((e) => e["call"] === "view.ask" && e["pending"] === true)).toHaveLength(1);
});

test("a resume refused before the run file opens leaves the paused note where it was", async () => {
  const entry = fileURLToPath(new URL("./child.ts", import.meta.url));
  const id = runId();
  const head = { at: "t", run: id, workflow: "/nowhere/missing.ts", params: {}, cwd: "/", root: "/" };
  const paused = { at: "t2", paused: { by: "limit", reason: "resets 3pm" } };
  fs.writeFileSync(runFile(id), `${JSON.stringify(head)}\n${JSON.stringify(paused)}\n`);

  const child = spawn(process.execPath, [entry, JSON.stringify({ id, resume: true })], {
    stdio: "ignore",
  });

  expect(await closed(child)).toBe(1);
  expect(readEntries(runFile(id))).toEqual([head, paused]);
}, 20000);
