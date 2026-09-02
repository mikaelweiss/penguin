// Lists what runs cost, from the usage notes their run files hold, so a change to a skill or
// an adapter can be checked against the runs before it.
// usage: bun examples/cost.ts [--since 2026-09-01] [--workflow review-pr] [--adapter claude] [--skills]
import fs from "node:fs";
import path from "node:path";
import {
  add,
  callsPerTurn,
  contextPerCall,
  fresh,
  spendOf,
  turnsOf,
  type Entry,
  type Spend,
} from "./helpers/spend.ts";
import { runsDir } from "../src/paths.ts";

/** One run's spend split three ways, since cost per token follows the vendor and the model. */
type Grouped = {
  skill: Map<string, Spend>;
  adapter: Map<string, Spend>;
  model: Map<string, Spend>;
};

type RunRecord = {
  id: string;
  at: string;
  workflow: string;
  parent: string | undefined;
  own: Spend;
  by: Grouped;
};

function grouped(): Grouped {
  return { skill: new Map(), adapter: new Map(), model: new Map() };
}

function into(group: Map<string, Spend>, name: string, spend: Spend): void {
  const held = group.get(name) ?? fresh();
  add(held, spend);
  group.set(name, held);
}

function merge(total: Grouped, more: Grouped): void {
  for (const key of ["skill", "adapter", "model"] as const) {
    for (const [name, spend] of more[key]) into(total[key], name, spend);
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function read(id: string): RunRecord | undefined {
  const file = path.join(runsDir(), id, "run.jsonl");
  if (!fs.existsSync(file)) return undefined;
  const entries: Entry[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      continue;
    }
  }
  const head = entries.find((entry) => "workflow" in entry && "params" in entry);
  if (head === undefined) return undefined;
  const own = fresh();
  const by = grouped();
  for (const turn of turnsOf(entries)) {
    const spent = spendOf(turn.usage, turn.calls);
    add(own, spent);
    into(by.skill, text(turn.usage["skill"]) ?? "(prompt)", spent);
    into(by.adapter, text(turn.usage["adapter"]) ?? "(unknown)", spent);
    into(by.model, text(turn.usage["model"]) ?? "(unknown)", spent);
  }
  const workflow = text(head["workflow"]) ?? "";
  return {
    id,
    at: text(head["at"]) ?? "",
    workflow: path.basename(workflow).replace(/\.ts$/, ""),
    parent: text(head["parent"]),
    own,
    by,
  };
}

function tokens(count: number): string {
  if (count < 1000) return `${Math.round(count)}`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function dollars(spend: Spend): string {
  return spend.priced ? `$${spend.usd.toFixed(2)}` : "-";
}

function perTurn(spend: Spend): string {
  return callsPerTurn(spend).toFixed(1);
}

function row(cells: string[], widths: number[]): string {
  return cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ");
}

function argOf(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

const since = argOf("--since") ?? "";
const only = argOf("--workflow");
const onlyAdapter = argOf("--adapter");
const showSkills = process.argv.includes("--skills");

const records = new Map<string, RunRecord>();
if (fs.existsSync(runsDir())) {
  for (const id of fs.readdirSync(runsDir())) {
    const record = read(id);
    if (record !== undefined) records.set(id, record);
  }
}

/** A run's spend with every run inside it, so a root run says what the whole tree cost. */
const children = new Map<string, RunRecord[]>();
for (const record of records.values()) {
  if (record.parent === undefined) continue;
  const list = children.get(record.parent) ?? [];
  list.push(record);
  children.set(record.parent, list);
}
function treeSpend(record: RunRecord, totals: Grouped): Spend {
  const total = fresh();
  add(total, record.own);
  merge(totals, record.by);
  for (const child of children.get(record.id) ?? []) add(total, treeSpend(child, totals));
  return total;
}

function usesAdapter(record: RunRecord, adapter: string): boolean {
  if (record.by.adapter.has(adapter)) return true;
  return (children.get(record.id) ?? []).some((child) => usesAdapter(child, adapter));
}

const roots = [...records.values()]
  .filter((record) => record.parent === undefined || !records.has(record.parent))
  .filter((record) => record.at >= since)
  .filter((record) => only === undefined || record.workflow === only)
  .filter((record) => onlyAdapter === undefined || usesAdapter(record, onlyAdapter))
  .sort((a, b) => a.at.localeCompare(b.at));

const byWorkflow = new Map<string, Spend>();
const totals = grouped();
const all = fresh();
const lines: string[][] = [];
for (const record of roots) {
  const total = treeSpend(record, totals);
  if (total.turns === 0) continue;
  into(byWorkflow, record.workflow, total);
  add(all, total);
  lines.push([
    record.at.slice(0, 16),
    record.workflow,
    `${total.turns}`,
    `${total.calls}`,
    tokens(contextPerCall(total)),
    tokens(total.input),
    tokens(total.cacheRead),
    tokens(total.cacheWrite),
    tokens(total.output),
    dollars(total),
    record.id,
  ]);
}

const header = [
  "started",
  "workflow",
  "turns",
  "calls",
  "ctx/call",
  "input",
  "cache rd",
  "cache wr",
  "output",
  "usd",
  "run",
];
const widths = header.map((cell, index) =>
  Math.max(cell.length, ...lines.map((line) => line[index]?.length ?? 0)),
);
const out = process.stdout;
out.write(`${row(header, widths)}\n`);
for (const line of lines) out.write(`${row(line, widths)}\n`);
if (lines.length === 0) {
  out.write("no runs with usage notes\n");
  process.exit(0);
}

function table(title: string, groups: Map<string, Spend>): void {
  out.write(`\n${title}\n`);
  const rows = [...groups.entries()]
    .sort((a, b) => b[1].usd - a[1].usd || b[1].cacheRead - a[1].cacheRead)
    .map(([name, spend]) => [
      name,
      `${spend.turns}`,
      perTurn(spend),
      tokens(contextPerCall(spend)),
      tokens(spend.input + spend.cacheRead + spend.cacheWrite + spend.output),
      dollars(spend),
    ]);
  const head = ["", "turns", "calls/turn", "ctx/call", "tokens", "usd"];
  const wide = head.map((cell, index) =>
    Math.max(cell.length, ...rows.map((line) => line[index]?.length ?? 0)),
  );
  out.write(`${row(head, wide)}\n`);
  for (const line of rows) out.write(`${row(line, wide)}\n`);
}

table("by workflow", byWorkflow);
table("by adapter", totals.adapter);
table("by model", totals.model);
if (showSkills) table("by skill", totals.skill);
out.write(
  `\ntotal: ${all.turns} turns, ${all.calls} tool calls, ${perTurn(all)} per turn, ` +
    `${tokens(contextPerCall(all))} context per call, ` +
    `${tokens(all.input + all.cacheRead + all.cacheWrite + all.output)} tokens, ${dollars(all)}\n`,
);
