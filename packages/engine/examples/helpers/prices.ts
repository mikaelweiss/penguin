import type { Usage } from "./turns.ts";

/** Dollars per million tokens: uncached input, cached input, output, and a cache write. */
export type Price = { input: number; cached: number; output: number; write: number };

/** A 5 minute cache write costs a quarter more than the same tokens sent uncached. */
const WRITE_PREMIUM = 1.25;

/**
 * A `price-<model> <input>,<cached>,<output>[,<write>]` line from ~/.penguin/config, in dollars
 * per million tokens. A model with no line stays unpriced, never zero. A line with no write price
 * takes the 5 minute tier's premium over input.
 */
export function priceOf(
  model: string | undefined,
  config: (key: string) => string | undefined,
): Price | undefined {
  if (model === undefined || model === "") return undefined;
  const line = config(`price-${model}`);
  if (line === undefined) return undefined;
  const parts = line.split(",").map((part) => Number(part.trim()));
  const [input, cached, output, write] = parts;
  if (parts.length < 3 || parts.length > 4) return undefined;
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return undefined;
  if (input === undefined || cached === undefined || output === undefined) return undefined;
  return { input, cached, output, write: write ?? input * WRITE_PREMIUM };
}

export function priced(
  usage: Usage,
  config: (key: string) => string | undefined,
): Usage {
  const price = priceOf(usage.model, config);
  if (price === undefined) return usage;
  const dollars =
    (usage.input * price.input +
      usage.cacheWrite * price.write +
      usage.cacheRead * price.cached +
      usage.output * price.output) /
    1e6;
  return { ...usage, usd: Math.round(dollars * 1e6) / 1e6 };
}
