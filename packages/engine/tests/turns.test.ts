import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Host } from "../src/core/adapter.ts";
import { RunPaused } from "../src/core/errors.ts";
import type { View } from "../src/core/view.ts";
import {
  compactTokens,
  narrated,
  sessions,
  type Invocation,
  type Turn,
  type Usage,
} from "../examples/helpers/turns.ts";

function viewWith(answers: string[]): { view: View; asked: string[] } {
  const asked: string[] = [];
  const view = {
    show: () => Promise.resolve(),
    act: () => Promise.resolve(),
    ask: (question: string) => {
      asked.push(question);
      return Promise.resolve(answers[asked.length - 1] ?? "stop");
    },
  } as unknown as View;
  return { view, asked };
}

function turning(values: (string | Error)[]): { start: () => Turn<string>; tries: () => number } {
  let tries = 0;
  const start = (): Turn<string> => {
    const answer = values[tries] ?? "value";
    tries += 1;
    return {
      output: (async function* () {})(),
      value: answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer),
    };
  };
  return { start, tries: () => tries };
}

test("a turn that did not finish runs again when the person says so", async () => {
  const { view, asked } = viewWith(["again"]);
  const { start, tries } = turning([new Error("claude exited with code 1"), "value"]);

  expect(await narrated(view, start)).toBe("value");
  expect(tries()).toBe(2);
  expect(asked[0]).toContain("claude exited with code 1");
});

test("a turn that did not finish ends the run only when the person says stop", async () => {
  const { view, asked } = viewWith(["stop"]);
  const { start, tries } = turning([new Error("claude exited with code 1")]);

  await expect(narrated(view, start)).rejects.toThrow("claude exited with code 1");
  expect(tries()).toBe(1);
  expect(asked).toHaveLength(1);
});

test("a turn that finishes never asks", async () => {
  const { view, asked } = viewWith([]);
  const { start } = turning(["value"]);

  expect(await narrated(view, start)).toBe("value");
  expect(asked).toHaveLength(0);
});

function hostWith(notes: Record<string, unknown>[], dir?: string): Host {
  return {
    cwd: "/",
    home: "/tmp",
    state: "/tmp",
    run: { id: "test", dir: dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "penguin-turns-")) },
    config: () => undefined,
    secret: async () => undefined,
    note: (entry) => {
      notes.push(entry);
    },
    open: () => {},
    skill: (name) => ({ name, description: "test skill", dir: "/tmp", text: "# Skill" }),
    shell: async () => ({ code: 0, stdout: "", stderr: "" }),
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    spawn: () => {
      throw new Error("no spawn in this test");
    },
  };
}

const SPENT: Usage = { model: "m", input: 1, cacheRead: 2, cacheWrite: 3, output: 4, usd: 0.01 };

test("every attempt that reports usage is noted, the failed one too, after it ran", async () => {
  const notes: Record<string, unknown>[] = [];
  let tries = 0;
  const agent = sessions(
    hostWith(notes),
    async () => {
      tries += 1;
      expect(notes).toHaveLength(tries - 1);
      return tries === 1
        ? { ok: false, error: "no", usage: SPENT }
        : { ok: true, value: null, usage: { ...SPENT, usd: 0.02 } };
    },
    "fake",
  );
  const session = await agent.open();
  await agent.turn(session, { skill: "review" }).value;
  expect(notes).toEqual([
    { usage: { adapter: "fake", session, skill: "review", ...SPENT } },
    { usage: { adapter: "fake", session, skill: "review", ...SPENT, usd: 0.02 } },
  ]);
});

test("an attempt without usage writes nothing, and a bare prompt names no skill", async () => {
  const notes: Record<string, unknown>[] = [];
  let tries = 0;
  const agent = sessions(
    hostWith(notes),
    async () => {
      tries += 1;
      return tries === 1 ? { ok: true, value: null } : { ok: true, value: null, usage: SPENT };
    },
    "fake",
  );
  const session = await agent.open();
  await agent.turn(session, "go").value;
  await agent.turn(session, "go").value;
  expect(notes).toEqual([{ usage: { adapter: "fake", session, ...SPENT } }]);
});

test("an autocompact option reads as a token count, and rejects what is not one", () => {
  expect(compactTokens("200000")).toBe(200000);
  expect(compactTokens("200k")).toBe(200000);
  expect(compactTokens("1M")).toBe(1000000);
  expect(compactTokens(" 1.5m ")).toBe(1500000);
  expect(compactTokens("auto")).toBeUndefined();
  expect(compactTokens("0")).toBeUndefined();
  expect(compactTokens("")).toBeUndefined();
  expect(compactTokens(undefined)).toBeUndefined();
});

test("a usage limit pauses the run, carrying when the window resets", async () => {
  const notes: Record<string, unknown>[] = [];
  let tries = 0;
  const agent = sessions(
    hostWith(notes),
    async () => {
      tries += 1;
      return { ok: false, error: "resets 3pm", limited: true, until: "2026-09-02T15:00:00.000Z" };
    },
    "fake",
  );
  const session = await agent.open();
  const turn = agent.turn(session, "go");
  const failure = await turn.value.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(RunPaused);
  expect((failure as RunPaused).by).toBe("limit");
  expect((failure as RunPaused).until).toBe("2026-09-02T15:00:00.000Z");
  expect(tries).toBe(1);
});

test("the sessions a run opened outlive its process, so a resume carries each one on", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-turns-"));
  const seen: { first: boolean; thread: string | undefined }[] = [];
  const runOnce = async (invocation: Invocation<{ model?: string }>) => {
    seen.push({ first: invocation.first, thread: invocation.thread });
    if (invocation.thread === undefined) invocation.keep("thread-9");
    return { ok: true as const, value: null };
  };

  const before = sessions(hostWith([], dir), runOnce, "fake");
  const session = await before.open({ model: "small" });
  await before.turn(session, "go").value;

  const after = sessions(hostWith([], dir), runOnce, "fake");
  await after.turn(session, "again").value;

  expect(seen).toEqual([
    { first: true, thread: undefined },
    { first: false, thread: "thread-9" },
  ]);
  expect(() => after.turn("nobody", "go")).toThrow(/no open session/);
});
