import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { createFilesView } from "../src/adapters/files-view.ts";
import { isWithdrawn, menuOf, type View } from "../src/core/index.ts";

let temps: string[] = [];

function filesView(): { view: View; dir: string; sent: (line: Record<string, unknown>) => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-view-"));
  temps.push(dir);
  fs.writeFileSync(path.join(dir, "run.jsonl"), "");
  fs.writeFileSync(path.join(dir, "inbox.jsonl"), "");
  return {
    view: createFilesView(dir),
    dir,
    sent: (line) => {
      fs.appendFileSync(path.join(dir, "inbox.jsonl"), `${JSON.stringify(line)}\n`);
    },
  };
}

function written(dir: string): string {
  return fs.readFileSync(path.join(dir, "run.jsonl"), "utf8");
}

/** The view polls the inbox, so a run file is read for what it will hold, never after a fixed wait. */
async function writes(dir: string, text: string): Promise<string> {
  const deadline = Date.now() + 5000;
  let held = written(dir);
  while (!held.includes(text) && Date.now() < deadline) {
    await Bun.sleep(25);
    held = written(dir);
  }
  return held;
}

afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps = [];
});

test("an answer line settles a plain ask with its text", async () => {
  const { view, sent } = filesView();
  const answer = view.ask("name?");
  sent({ answer: "pip" });
  expect(await answer).toBe("pip");
});

test("a typed answer that does not fit is rejected in the run file, the ask stays open", async () => {
  const { view, dir, sent } = filesView();
  const answer = view.ask("pick", z.enum(["a", "b"]));
  sent({ answer: "zzz" });
  expect(await writes(dir, '"rejected":"zzz"')).toContain('"rejected":"zzz"');
  sent({ answer: "a" });
  expect(await answer).toBe("a");
});

test("a typed ask parses JSON answers into shaped values", async () => {
  const { view, sent } = filesView();
  const answer = view.ask("how many?", z.number());
  sent({ answer: "4" });
  expect(await answer).toBe(4);
});

test("parallel asks answer in order, one at a time", async () => {
  const { view, sent } = filesView();
  const first = view.ask("one?");
  const second = view.ask("two?");
  sent({ answer: "1" });
  sent({ answer: "2" });
  expect(await first).toBe("1");
  expect(await second).toBe("2");
});

test("an array answer fits an array shape without quoting tricks", async () => {
  const { view, sent } = filesView();
  const answer = view.ask("which?", z.array(z.enum(["a", "b", "c"])));
  sent({ answer: ["a", "c"] });
  expect(await answer).toEqual(["a", "c"]);
});

test("listen hears message lines and notes the listening state", async () => {
  const { view, dir, sent } = filesView();
  const messages = view.listen()[Symbol.asyncIterator]();
  const waiting = messages.next();
  sent({ message: "hello there" });
  expect((await waiting).value).toEqual({ text: "hello there" });
  await messages.return?.(undefined);
  expect(written(dir)).toContain('"listening":true');
  expect(written(dir)).toContain('"listening":false');
});

test("an answer line settles the ask, message lines reach the listener", async () => {
  const { view, sent } = filesView();
  const messages = view.listen()[Symbol.asyncIterator]();
  const answer = view.ask("name?");
  sent({ answer: "pip" });
  expect(await answer).toBe("pip");
  const waiting = messages.next();
  sent({ message: "after" });
  expect((await waiting).value).toEqual({ text: "after" });
  await messages.return?.(undefined);
});

test("open notes the url, and a workflow that means it twice says it twice", async () => {
  const { view, dir } = filesView();
  await view.open("http://localhost:5173");
  await view.open("http://localhost:5173");
  const opened = written(dir)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => "open" in entry);
  expect(opened.map((entry) => entry["open"])).toEqual([
    "http://localhost:5173",
    "http://localhost:5173",
  ]);
});

test("a dead premise withdraws the ask, and the next answer lands on the live question", async () => {
  const { view, dir, sent } = filesView();
  let moot: (reason: string) => void = () => {};
  const closed = new Promise<string>((settle) => {
    moot = settle;
  });
  const stale = view.ask("act on the PR?", z.enum(["go", "skip"]), { until: closed });
  const live = view.ask("still here?");

  moot("the PR merged");
  const first = await stale;
  expect(isWithdrawn(first)).toBe(true);
  if (isWithdrawn(first)) expect(first.reason).toBe("the PR merged");
  expect(await writes(dir, '"withdrawn"')).toContain('"withdrawn":"the PR merged"');

  sent({ answer: "yes" });
  expect(await live).toBe("yes");
});

test("an answer that beats the premise wins, and the withdrawal is a no-op", async () => {
  const { view, sent } = filesView();
  let moot: (reason: string) => void = () => {};
  const closed = new Promise<string>((settle) => {
    moot = settle;
  });
  const asked = view.ask("act on the PR?", z.enum(["go", "skip"]), { until: closed });
  sent({ answer: "go" });
  expect(await asked).toBe("go");
  moot("too late");
  expect(isWithdrawn(await asked)).toBe(false);
});

test("a boolean shape maps to yes and no", () => {
  const menu = menuOf(z.boolean());
  expect(menu?.choices.map((choice) => choice.label)).toEqual(["yes", "no"]);
  expect(menu?.choices.map((choice) => choice.value)).toEqual([true, false]);
  expect(menu?.other).toBe(false);
  expect(menu?.many).toBe(false);
});

test("an enum shape maps to its options", () => {
  const menu = menuOf(z.enum(["replace", "reuse", "stop"]));
  expect(menu?.choices.map((choice) => choice.label)).toEqual(["replace", "reuse", "stop"]);
  expect(menu?.many).toBe(false);
});

test("a union of options and text keeps the options and admits free text", () => {
  const menu = menuOf(z.union([z.enum(["approve"]), z.string()]));
  expect(menu?.choices.map((choice) => choice.label)).toEqual(["approve"]);
  expect(menu?.other).toBe(true);
});

test("an array of options maps to a multi-select", () => {
  const menu = menuOf(z.array(z.enum(["a", "b"])));
  expect(menu?.many).toBe(true);
  expect(menu?.choices.map((choice) => choice.label)).toEqual(["a", "b"]);
});

test("a free shape has no menu", () => {
  expect(menuOf(z.string())).toBeUndefined();
  expect(menuOf(z.object({ a: z.string() }))).toBeUndefined();
});
