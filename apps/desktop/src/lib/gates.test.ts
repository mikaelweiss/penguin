import { expect, test } from "bun:test";

import { ended, troubles } from "@/lib/gates";

test("a comment, a blank line, and a scoped command are all fine", () => {
  expect(
    troubles("# what a change has to pass\n\nbun run check\n[apps/desktop] tsc -b\n"),
  ).toEqual([]);
});

test("a scope with nothing after it is called out by line", () => {
  expect(troubles("bun test\n[packages/engine]\n")).toEqual([
    { line: 2, detail: "a scope with no command after it is not a gate" },
  ]);
});

test("a scope that never closes is called out", () => {
  expect(troubles("[apps/desktop bun test\n")).toEqual([
    {
      line: 1,
      detail: "the scope never closes, so the bracket runs as part of the command",
    },
  ]);
});

test("a saved file always closes its last line", () => {
  expect(ended("bun run check")).toBe("bun run check\n");
  expect(ended("bun run check\n")).toBe("bun run check\n");
});
