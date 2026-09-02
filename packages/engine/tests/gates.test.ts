import { expect, test } from "bun:test";
import { gatesFor, parseGates, reportOf, tail, under } from "../examples/helpers/gates.ts";

test("a plain line is a gate that always runs", () => {
  expect(parseGates("bun run check\n")).toEqual([{ command: "bun run check", scope: "" }]);
});

test("blank lines and comments are not gates", () => {
  const text = "# the gates\n\nbun test\n   \n#bun run lint\n";
  expect(parseGates(text)).toEqual([{ command: "bun test", scope: "" }]);
});

test("a bracket names the path the gate is scoped to", () => {
  const text = "bun run check\n[apps/desktop] nx run penguin-desktop:typecheck\n";
  expect(parseGates(text)).toEqual([
    { command: "bun run check", scope: "" },
    { command: "nx run penguin-desktop:typecheck", scope: "apps/desktop" },
  ]);
});

test("a scope with no command behind it is not a gate", () => {
  expect(parseGates("[apps/desktop]\n[packages/ui]   \n")).toEqual([]);
});

test("a scope matches whole path segments, never a name that only starts the same", () => {
  expect(under("apps/desktop", "apps/desktop/src/x.ts")).toBe(true);
  expect(under("apps/desktop", "apps/desktop")).toBe(true);
  expect(under("apps/desktop", "apps/desktop-old/x.ts")).toBe(false);
  expect(under("apps/desktop", "apps/docs/x.ts")).toBe(false);
  expect(under("apps/desktop/", "./apps/desktop/src/x.ts")).toBe(true);
});

test("only the gates a changed file sits under run", () => {
  const gates = parseGates(
    "bun run check\n[apps/desktop] nx typecheck\n[packages/engine] bun test packages/engine\n",
  );
  expect(gatesFor(gates, ["packages/engine/src/run.ts"])).toEqual([
    { command: "bun run check", scope: "" },
    { command: "bun test packages/engine", scope: "packages/engine" },
  ]);
});

test("unknown changed files run every gate", () => {
  const gates = parseGates("bun run check\n[apps/desktop] nx typecheck\n");
  expect(gatesFor(gates, undefined)).toHaveLength(2);
  expect(gatesFor(gates, [])).toHaveLength(1);
});

test("the report gives each gate one line, and puts a failure's output under it", () => {
  const report = reportOf([
    { command: "bun run check", code: 0, output: "" },
    { command: "bun test", code: 1, output: "1 fail: run.test.ts" },
  ]);
  expect(report).toBe("bun run check: pass\nbun test: fail\n1 fail: run.test.ts\n");
});

test("a report of nothing says so, rather than reading as green", () => {
  expect(reportOf([])).toBe("no gates ran");
});

test("a long output keeps its tail, which is where the failure names itself", () => {
  const text = `${"a".repeat(50)}the failure`;
  expect(tail(text, 11)).toBe("… the failure");
  expect(tail("  short  ", 11)).toBe("short");
});
