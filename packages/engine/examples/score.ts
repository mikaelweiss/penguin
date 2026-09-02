// Scores the skills against the work already done: per adapter and model, how often a person
// took the output as it stood, sent it back, or dropped it, and whether it is what shipped.
// usage: bun examples/score.ts [--since 2026-09-01] [--workflow plan] [--json] [--key <dir>]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  casesOf,
  cells,
  digest,
  HEADER,
  meanRounds,
  summary,
  tally,
  totals,
  type Case,
  type Digest,
  type Repo,
  type Row,
} from "./helpers/score.ts";
import { configFile, runsDir } from "../src/paths.ts";

type Branches = { all: ReadonlySet<string>; merged: ReadonlySet<string> };

function git(root: string, ...command: string[]): string | undefined {
  const ran = spawnSync("git", ["-C", root, ...command], { encoding: "utf8", maxBuffer: 1 << 28 });
  return ran.status === 0 ? ran.stdout : undefined;
}

function lines(out: string | undefined): string[] {
  if (out === undefined) return [];
  return out
    .split("\n")
    .map((line) => line.replace(/^[*+]?\s*/, "").trim())
    .filter((line) => line !== "");
}

/** origin's own default, then the names a repository without a remote falls back to. */
function defaultBranch(root: string, all: ReadonlySet<string>): string | undefined {
  const named = git(root, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")?.trim();
  const short = named === undefined ? undefined : named.replace(/^origin\//, "");
  if (short !== undefined && short !== "") return short;
  return ["main", "master"].find((name) => all.has(name));
}

/** Reads git once per repository, and remembers a repository that is no longer there. */
function repository(): Repo {
  const subjects = new Map<string, ReadonlySet<string> | undefined>();
  const branches = new Map<string, Branches | undefined>();
  const present = (root: string): boolean =>
    root !== "" && fs.existsSync(root) && git(root, "rev-parse", "--git-dir") !== undefined;
  return {
    subjects(root) {
      if (subjects.has(root)) return subjects.get(root);
      const found = present(root)
        ? new Set(lines(git(root, "log", "--all", "--format=%s")))
        : undefined;
      subjects.set(root, found);
      return found;
    },
    branches(root) {
      if (branches.has(root)) return branches.get(root);
      let found: Branches | undefined;
      if (present(root)) {
        const all = new Set(lines(git(root, "branch", "--format=%(refname:short)")));
        const base = defaultBranch(root, all);
        const merged =
          base === undefined
            ? new Set<string>()
            : new Set(lines(git(root, "branch", "--merged", base, "--format=%(refname:short)")));
        found = { all, merged };
      }
      branches.set(root, found);
      return found;
    },
  };
}

/** The adapter a turn with no usage note ran on, as the config names it. */
function configuredAdapter(): string {
  const file = configFile();
  if (!fs.existsSync(file)) return "unknown";
  const named = /^agent\s+(\S+)\s*$/m.exec(fs.readFileSync(file, "utf8"))?.[1];
  return named ?? "unknown";
}

function argOf(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

function row(list: string[], widths: number[]): string {
  return list.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ");
}

function table(out: NodeJS.WriteStream, title: string, body: string[][]): void {
  const widths = HEADER.map((cell, index) =>
    Math.max(cell.length, ...body.map((line) => line[index]?.length ?? 0)),
  );
  out.write(`\n${title}\n`);
  out.write(`${row(HEADER, widths)}\n`);
  for (const line of body) out.write(`${row(line, widths)}\n`);
}

/** One row as --json reports it: the counts, with the rounds boiled down to their mean. */
function counted(row: Row): Record<string, number | null> {
  return {
    n: row.n,
    accepted: row.accepted,
    edited: row.edited,
    rejected: row.rejected,
    measured: row.measured,
    matched: row.matched,
    meanRounds: meanRounds(row),
  };
}

function writeKey(dir: string, cases: Case[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const bySkill = new Map<string, Case[]>();
  for (const found of cases) {
    const held = bySkill.get(found.skill) ?? [];
    held.push(found);
    bySkill.set(found.skill, held);
  }
  for (const [skill, held] of bySkill) {
    fs.writeFileSync(path.join(dir, `${skill}.json`), `${JSON.stringify(held, null, 2)}\n`);
  }
}

const since = argOf("--since") ?? "";
const only = argOf("--workflow");
const keyDir = argOf("--key");
const asJson = process.argv.includes("--json");

const runs = new Map<string, Digest>();
if (fs.existsSync(runsDir())) {
  for (const id of fs.readdirSync(runsDir())) {
    const file = path.join(runsDir(), id, "run.jsonl");
    if (!fs.existsSync(file)) continue;
    const read = digest(id, fs.readFileSync(file, "utf8"));
    if (read !== undefined) runs.set(id, read);
  }
}

const cases = casesOf(runs, repository(), configuredAdapter())
  .filter((found) => found.at >= since)
  .filter((found) => only === undefined || found.workflow === only);

if (keyDir !== undefined) writeKey(keyDir, cases);

const buckets = tally(cases);
const all = totals(cases);
const out = process.stdout;

if (asJson) {
  const rows = buckets.map((bucket) => ({
    skill: bucket.skill,
    adapter: bucket.adapter,
    model: bucket.model,
    ...counted(bucket.row),
  }));
  out.write(`${JSON.stringify({ rows, totals: counted(all) }, null, 2)}\n`);
  process.exit(0);
}

if (cases.length === 0) {
  out.write("no judged turns in these runs\n");
  process.exit(0);
}

let skill = "";
let body: string[][] = [];
for (const bucket of buckets) {
  if (bucket.skill !== skill && body.length > 0) table(out, skill, body);
  if (bucket.skill !== skill) body = [];
  skill = bucket.skill;
  body.push(cells(bucket));
}
if (body.length > 0) table(out, skill, body);
out.write(`\n${summary(all)}\n`);
if (keyDir !== undefined) out.write(`answer key: ${keyDir}\n`);
