import { expect, test } from "bun:test";
import type { View } from "../src/core/view.ts";
import { narrated, type Turn } from "../examples/helpers/turns.ts";

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
