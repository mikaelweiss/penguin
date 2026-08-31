// Lists what runs cost, from the usage notes their run files hold, so a change to a skill or
// an adapter can be checked against the runs before it.
// usage: bun examples/cost.ts [--since 2026-09-01] [--workflow review-pr] [--skills]
import fs from "node:fs";
import path from "node:path";
import { runsDir } from "../src/paths.ts";

type Entry = Record<string, unknown>;

type Spend = {
  turns: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  usd: number;
  priced: boolean;
};

type RunRecord = {
  id: string;
  at: string;
  workflow: string;
  parent: string | undefined;
  own: Spend;
  bySkill: Map<string, Spend>;
};

function fresh(): Spend {
  return { turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0, priced: false };
}

function add(total: Spend, more: Spend): void {
  total.turns += more.turns;
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

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function spendOf(usage: Record<string, unknown>): Spend {
  const usd = usage["usd"];
  return {
    turns: 1,
    input: number(usage["input"]),
    cacheRead: number(usage["cacheRead"]),
    cacheWrite: number(usage["cacheWrite"]),
    output: number(usage["output"]),
    usd: typeof usd === "number" ? usd : 0,
    priced: typeof usd === "number",
  };
}

function read(id: string): RunRecord | undefined {
  const file = path.join(runsDir(), id, "run.jsonl");
  if (!fs.existsSync(file)) return undefined;
  let head: Entry | undefined;
  const own = fresh();
  const bySkill = new Map<string, Spend>();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (head === undefined && "workflow" in entry && "params" in entry) head = entry;
    const usage = entry["usage"];
    if (usage === null || typeof usage !== "object") continue;
    const spent = spendOf(usage as Record<string, unknown>);
    add(own, spent);
    const skill = text((usage as Record<string, unknown>)["skill"]) ?? "(prompt)";
    const held = bySkill.get(skill) ?? fresh();
    add(held, spent);
    bySkill.set(skill, held);
  }
  if (head === undefined) return undefined;
  const workflow = text(head["workflow"]) ?? "";
  return {
    id,
    at: text(head["at"]) ?? "",
    workflow: path.basename(workflow).replace(/\.ts$/, ""),
    parent: text(head["parent"]),
    own,
    bySkill,
  };
}

function tokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function dollars(spend: Spend): string {
  return spend.priced ? `$${spend.usd.toFixed(2)}` : "-";
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
function treeSpend(record: RunRecord, skills: Map<string, Spend>): Spend {
  const total = fresh();
  add(total, record.own);
  for (const [skill, spend] of record.bySkill) {
    const held = skills.get(skill) ?? fresh();
    add(held, spend);
    skills.set(skill, held);
  }
  for (const child of children.get(record.id) ?? []) add(total, treeSpend(child, skills));
  return total;
}

const roots = [...records.values()]
  .filter((record) => record.parent === undefined || !records.has(record.parent))
  .filter((record) => record.at >= since)
  .filter((record) => only === undefined || record.workflow === only)
  .sort((a, b) => a.at.localeCompare(b.at));

const byWorkflow = new Map<string, Spend>();
const bySkill = new Map<string, Spend>();
const all = fresh();
const lines: string[][] = [];
for (const record of roots) {
  const total = treeSpend(record, bySkill);
  if (total.turns === 0) continue;
  const held = byWorkflow.get(record.workflow) ?? fresh();
  add(held, total);
  byWorkflow.set(record.workflow, held);
  add(all, total);
  lines.push([
    record.at.slice(0, 16),
    record.workflow,
    `${total.turns}`,
    tokens(total.input),
    tokens(total.cacheRead),
    tokens(total.cacheWrite),
    tokens(total.output),
    dollars(total),
    record.id,
  ]);
}

const header = ["started", "workflow", "turns", "input", "cache read", "cache write", "output", "usd", "run"];
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
      tokens(spend.input + spend.cacheRead + spend.cacheWrite + spend.output),
      dollars(spend),
    ]);
  const head = ["", "turns", "tokens", "usd"];
  const wide = head.map((cell, index) =>
    Math.max(cell.length, ...rows.map((line) => line[index]?.length ?? 0)),
  );
  out.write(`${row(head, wide)}\n`);
  for (const line of rows) out.write(`${row(line, wide)}\n`);
}

table("by workflow", byWorkflow);
if (showSkills) table("by skill", bySkill);
out.write(
  `\ntotal: ${all.turns} turns, ${tokens(all.input + all.cacheRead + all.cacheWrite + all.output)} tokens, ${dollars(all)}\n`,
);
