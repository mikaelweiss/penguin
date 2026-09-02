/** One line of a run file. */
export type Entry = Record<string, unknown>;

/** What a set of turns cost, with the tool calls those turns made. */
export type Spend = {
  turns: number;
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  usd: number;
  priced: boolean;
};

/** A usage note with the tool calls of the turn that produced it. */
export type TurnSpend = { usage: Record<string, unknown>; calls: number };

export function fresh(): Spend {
  return { turns: 0, calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0, priced: false };
}

export function add(total: Spend, more: Spend): void {
  total.turns += more.turns;
  total.calls += more.calls;
  total.input += more.input;
  total.cacheRead += more.cacheRead;
  total.cacheWrite += more.cacheWrite;
  total.output += more.output;
  total.usd += more.usd;
  total.priced = total.priced || more.priced;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function spendOf(usage: Record<string, unknown>, calls: number): Spend {
  const usd = usage["usd"];
  return {
    turns: 1,
    calls,
    input: number(usage["input"]),
    cacheRead: number(usage["cacheRead"]),
    cacheWrite: number(usage["cacheWrite"]),
    output: number(usage["output"]),
    usd: typeof usd === "number" ? usd : 0,
    priced: typeof usd === "number",
  };
}

/**
 * A tool call journals four view.act entries: a pending entry and its settled entry for the
 * running status, then the same pair for done or failed. The running pending entry counts it once.
 */
function isToolCall(entry: Entry): boolean {
  if (entry["call"] !== "view.act" || entry["pending"] !== true) return false;
  const args = entry["args"];
  if (!Array.isArray(args)) return false;
  const action: unknown = args[0];
  if (action === null || typeof action !== "object") return false;
  return (action as Record<string, unknown>)["status"] === "running";
}

/**
 * Every usage note of a run with the tool calls made since the note before it, which are the calls
 * of the turn that note prices. Calls after the last note belong to a turn that never reported.
 */
export function turnsOf(entries: Iterable<Entry>): TurnSpend[] {
  const turns: TurnSpend[] = [];
  let calls = 0;
  for (const entry of entries) {
    if (isToolCall(entry)) {
      calls += 1;
      continue;
    }
    const usage = entry["usage"];
    if (usage === null || typeof usage !== "object") continue;
    turns.push({ usage: usage as Record<string, unknown>, calls });
    calls = 0;
  }
  return turns;
}

/** Every tool call is answered by an API call, and one more call ends the turn. */
export function apiCalls(spend: Spend): number {
  return spend.calls + spend.turns;
}

export function callsPerTurn(spend: Spend): number {
  return spend.turns === 0 ? 0 : spend.calls / spend.turns;
}

/** The tokens the model reads on an average API call, which is what a long turn really bills for. */
export function contextPerCall(spend: Spend): number {
  const calls = apiCalls(spend);
  return calls === 0 ? 0 : (spend.input + spend.cacheRead + spend.cacheWrite) / calls;
}
