import type { Usage } from "./turns.ts";

/** Dollars per million tokens: uncached input, cached input, output. */
export type Price = { input: number; cached: number; output: number };

/**
 * A price line from ~/.penguin/config: `price-<model> <input>,<cached>,<output>` in dollars per
 * million tokens. A CLI that reports tokens but no dollars gets its usd from here, and a model
 * with no line stays priced at unknown, never at zero.
 */
export function priceOf(
  model: string | undefined,
  config: (key: string) => string | undefined,
): Price | undefined {
  if (model === undefined || model === "") return undefined;
  const line = config(`price-${model}`);
  if (line === undefined) return undefined;
  const parts = line.split(",").map((part) => Number(part.trim()));
  const [input, cached, output] = parts;
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return undefined;
  }
  if (input === undefined || cached === undefined || output === undefined) return undefined;
  return { input, cached, output };
}

/** The usage with usd filled in when a price is known. Cache writes count as uncached input. */
export function priced(
  usage: Usage,
  config: (key: string) => string | undefined,
): Usage {
  const price = priceOf(usage.model, config);
  if (price === undefined) return usage;
  const dollars =
    ((usage.input + usage.cacheWrite) * price.input +
      usage.cacheRead * price.cached +
      usage.output * price.output) /
    1e6;
  return { ...usage, usd: Math.round(dollars * 1e6) / 1e6 };
}
