import { expect, test } from "bun:test";
import { priceOf, priced } from "../examples/helpers/prices.ts";
import type { Usage } from "../examples/helpers/turns.ts";

const SPENT: Usage = { model: "gpt-x", input: 1_000_000, cacheRead: 2_000_000, cacheWrite: 500_000, output: 100_000 };

function configOf(lines: Record<string, string>): (key: string) => string | undefined {
  return (key) => lines[key];
}

test("a price line prices the usage in dollars per million tokens", () => {
  const config = configOf({ "price-gpt-x": "2, 0.5, 10" });
  expect(priceOf("gpt-x", config)).toEqual({ input: 2, cached: 0.5, output: 10 });
  // (1M + 0.5M) * 2 + 2M * 0.5 + 0.1M * 10, over a million
  expect(priced(SPENT, config).usd).toBe(5);
});

test("no line, no model, or a malformed line leaves usd unknown", () => {
  expect(priced(SPENT, configOf({})).usd).toBeUndefined();
  expect(priced({ ...SPENT, model: undefined }, configOf({ "price-gpt-x": "1,1,1" })).usd).toBeUndefined();
  for (const bad of ["1,2", "a,b,c", "1,-2,3", ""]) {
    expect(priceOf("gpt-x", configOf({ "price-gpt-x": bad }))).toBeUndefined();
  }
});
