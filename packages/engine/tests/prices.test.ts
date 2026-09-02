import { expect, test } from "bun:test";
import { priceOf, priced } from "../examples/helpers/prices.ts";
import type { Usage } from "../examples/helpers/turns.ts";

const SPENT: Usage = { model: "gpt-x", input: 1_000_000, cacheRead: 2_000_000, cacheWrite: 500_000, output: 100_000 };

function configOf(lines: Record<string, string>): (key: string) => string | undefined {
  return (key) => lines[key];
}

test("a price line prices the usage in dollars per million tokens", () => {
  const config = configOf({ "price-gpt-x": "2, 0.5, 10" });
  // A line that names no write price takes the 5 minute tier's premium over its input price.
  expect(priceOf("gpt-x", config)).toEqual({ input: 2, cached: 0.5, output: 10, write: 2.5 });
  // 1M * 2 + 0.5M * 2.5 + 2M * 0.5 + 0.1M * 10, over a million
  expect(priced(SPENT, config).usd).toBe(5.25);
});

test("a fourth number is the cache write price, so a dear tier is not billed as plain input", () => {
  const config = configOf({ "price-gpt-x": "2,0.5,10,4" });
  expect(priceOf("gpt-x", config)).toEqual({ input: 2, cached: 0.5, output: 10, write: 4 });
  // 1M * 2 + 0.5M * 4 + 2M * 0.5 + 0.1M * 10, over a million
  expect(priced(SPENT, config).usd).toBe(6);
});

test("no line, no model, or a malformed line leaves usd unknown", () => {
  expect(priced(SPENT, configOf({})).usd).toBeUndefined();
  expect(priced({ ...SPENT, model: undefined }, configOf({ "price-gpt-x": "1,1,1" })).usd).toBeUndefined();
  for (const bad of ["1,2", "a,b,c", "1,-2,3", "1,2,3,4,5", ""]) {
    expect(priceOf("gpt-x", configOf({ "price-gpt-x": bad }))).toBeUndefined();
  }
});
