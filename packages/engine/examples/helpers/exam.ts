/**
 * The exam's pure parts: which cases a replay runs, how each skill's answer is graded against
 * the key, and what the run cost. The workflow feeds these text and the tests feed them fixtures.
 *
 * A grader reports one rule per column. A rule the case carries no evidence for reports null,
 * which is not a failure: a commit prompt written before the workflow sent the recent subjects
 * cannot say whether the answer follows the repository's prefix style.
 */
import { subjectOf, type Case, type Verdict } from "./score.ts";
import { spendOf, turnsOf, type Entry } from "./spend.ts";

export type { Entry };

/**
 * One rule of a grader. null means the case says nothing about it. A rule that does not count
 * informs the reader and never fails the case.
 */
export type Rule = { name: string; ok: boolean | null; counts?: boolean };

export type Grade = { pass: boolean; rules: Rule[]; detail: string };

/** A case with the id that names it: the run, and which of that run's cases it is. */
export type Picked = { id: string; held: Case };

/** What a run's usage notes priced, with the grader's share of it counted apart. */
export type Cost = { usd: number; judge: number; priced: boolean };

/** The skills a grader runs on. Their spend is the exam's own, not the model's under test. */
export const JUDGE_SKILLS = ["exam-judge-plan", "exam-judge-findings", "review"];

/** The skills that need a grading turn, so an exam on one refuses a judge that is the model under test. */
export const JUDGED_SKILLS = ["plan", "triage", "implement", "review-pr", "assess-feedback"];

export function entriesOf(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      continue;
    }
  }
  return entries;
}

export function costOf(entries: Entry[]): Cost {
  let usd = 0;
  let judge = 0;
  let priced = false;
  for (const turn of turnsOf(entries)) {
    const spent = spendOf(turn.usage, turn.calls);
    usd += spent.usd;
    priced = priced || spent.priced;
    const skill = turn.usage["skill"];
    if (typeof skill === "string" && JUDGE_SKILLS.includes(skill)) judge += spent.usd;
  }
  return { usd, judge, priced };
}

/** The run a spawned attempt wrote, which is the newest one started since marker for this case. */
export function attemptRun(
  runs: { id: string; head: Entry }[],
  marker: string,
  id: string,
  trial: number,
): string | undefined {
  const mine = runs
    .filter((run) => run.id >= marker)
    .filter((run) => {
      const params = run.head["params"];
      if (params === null || typeof params !== "object") return false;
      const held = params as Record<string, unknown>;
      return held["only"] === id && held["trial"] === trial;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return mine.at(-1)?.id;
}

/** Every case with the id that names it. One run holds several cases when it judged several turns. */
export function identify(cases: Case[]): Picked[] {
  const counts = new Map<string, number>();
  return cases.map((held) => {
    const at = (counts.get(held.run) ?? 0) + 1;
    counts.set(held.run, at);
    return { id: `${held.run}#${at}`, held };
  });
}

/** The cases a run replays: newest first, restricted to what was named, cut to limit. */
export function pickCases(picked: Picked[], options: { limit: number; only: string[] }): Picked[] {
  const newest = [...picked].reverse();
  const wanted =
    options.only.length === 0
      ? newest
      : newest.filter((one) => options.only.includes(one.id) || options.only.includes(one.held.run));
  return wanted.slice(0, options.limit);
}

export function sectionOf(prompt: string, name: string): string | undefined {
  const open = `<${name}>`;
  const close = `</${name}>`;
  const start = prompt.indexOf(open);
  if (start === -1) return undefined;
  const end = prompt.indexOf(close, start);
  if (end === -1) return undefined;
  return prompt.slice(start + open.length, end).trim();
}

const STATUS_LINE = /^(\S{1,2})\s+(.+)$/;

/** The paths git named in the prompt's status section, each one spelled as a commit must spell it. */
export function statusPaths(prompt: string): string[] {
  const section = sectionOf(prompt, "status");
  if (section === undefined) return [];
  const paths: string[] = [];
  for (const line of section.split("\n")) {
    const found = STATUS_LINE.exec(line.trim());
    if (found?.[2] !== undefined) paths.push(found[2]);
  }
  return paths;
}

/** The subject lines the prompt carried, or undefined when it carried none to read a style off. */
export function recentSubjects(prompt: string): string[] | undefined {
  const section = sectionOf(prompt, "recent_subjects");
  if (section === undefined) return undefined;
  const subjects = section.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return subjects.length === 0 ? undefined : subjects;
}

const TICKET = /^[A-Z][A-Z0-9]*-\d+(?:\/[A-Z][A-Z0-9]*-\d+)*\s+/;

/**
 * The convention part of a subject's prefix: what stands before the first colon, without the
 * issue id. The id comes from the ticket the work is for, so it never says whether the answer
 * writes subjects the way this repository writes them.
 */
export function prefixOf(subject: string): string {
  const colon = subject.indexOf(":");
  if (colon === -1) return "";
  return subject.slice(0, colon).replace(TICKET, "").trim();
}

/** git's own ceiling for a subject line, which is where the schema stops one. */
export const SUBJECT_LIMIT = 72;

/** What the commit skill asks a subject to stay under. */
export const SUBJECT_TARGET = 50;

export type Written = { files: string[]; subject: string; body: string };

function ruled(rules: Rule[], detail: string): Grade {
  const pass = rules.every((rule) => rule.counts === false || rule.ok !== false);
  return { pass, rules, detail };
}

/**
 * The commit grader. Everything it needs is in the prompt and the key, so no judge runs:
 * the files are the ones git reported, the subject reads as a subject, its prefix follows
 * the subjects the prompt carried. Whether it says what the commit that shipped says is
 * reported and never required: another subject can name the change as well.
 */
export function gradeCommit(prompt: string, written: Written, artifact: string): Grade {
  const paths = new Set(statusPaths(prompt));
  // The case is a commit that happened, so an answer that commits nothing is not that commit.
  const files =
    written.files.length > 0 && written.files.every((file) => paths.has(file));
  const subject = written.subject.trim();
  const shape = subject.replace(TICKET, "").length < SUBJECT_TARGET && !subject.endsWith(".");
  const subjects = recentSubjects(prompt);
  const prefix =
    subjects === undefined
      ? null
      : subjects.map(prefixOf).includes(prefixOf(subject));
  const shipped = subjectOf(artifact);
  const merged = shipped === "" ? null : subject === shipped;
  const rules: Rule[] = [
    { name: "files", ok: files },
    { name: "subject", ok: shape },
    { name: "prefix", ok: prefix },
    { name: "merged", ok: merged, counts: false },
  ];
  return ruled(rules, subject);
}

export type PlanJudgment = { equivalent: boolean; missing: string[]; extra: string[] };

/** The plan and triage grader: the judge's word on whether the candidate decides the same work. */
export function gradePlan(judged: PlanJudgment): Grade {
  const said = [
    judged.missing.length === 0 ? "" : `missing: ${judged.missing.join("; ")}`,
    judged.extra.length === 0 ? "" : `extra: ${judged.extra.join("; ")}`,
  ].filter((part) => part !== "");
  return ruled(
    [{ name: "equivalent", ok: judged.equivalent }],
    said.length === 0 ? "same work" : said.join(" | "),
  );
}

export type FindingsJudgment = { matched: string[]; missed: string[]; invented: string[] };

/** What the candidate found of what was recorded, and how much of what it found was recorded. */
export function ratesOf(judged: FindingsJudgment): { recall: number | null; precision: number | null } {
  const recalled = judged.matched.length + judged.missed.length;
  const offered = judged.matched.length + judged.invented.length;
  return {
    recall: recalled === 0 ? null : judged.matched.length / recalled,
    precision: offered === 0 ? null : judged.matched.length / offered,
  };
}

function percent(rate: number | null): string {
  return rate === null ? "-" : `${Math.round(rate * 100)}%`;
}

/**
 * The findings grader for review-pr and assess-feedback. What the person took stands as the
 * answer, so the candidate has to find all of it; what the person dropped stands as the wrong
 * answer, so the candidate that finds it again fails.
 */
export function gradeFindings(judged: FindingsJudgment, verdict: Verdict): Grade {
  const kept = verdict !== "rejected";
  const ok = kept ? judged.missed.length === 0 : judged.matched.length === 0;
  const rates = ratesOf(judged);
  const said = `recall ${percent(rates.recall)}, precision ${percent(rates.precision)}`;
  const missed = judged.missed.length === 0 ? "" : ` | missed: ${judged.missed.join("; ")}`;
  const found = judged.matched.length === 0 ? "" : ` | matched: ${judged.matched.join("; ")}`;
  return ruled(
    [{ name: kept ? "found" : "dropped", ok }],
    kept ? `${said}${missed}` : `${said}${found}`,
  );
}

/** The implement grader: the gates the workflow runs, and the reviewer's verdict on the tree. */
export function gradeImplement(green: boolean, verdict: string, blocking: string): Grade {
  const rules: Rule[] = [
    { name: "gates", ok: green },
    { name: "approved", ok: verdict === "approved" },
  ];
  const said = blocking.trim() === "" ? verdict : `${verdict}: ${blocking.trim()}`;
  return ruled(rules, said);
}

/** The grade an attempt that never produced an answer gets. */
export function failed(detail: string): Grade {
  return { pass: false, rules: [{ name: "ran", ok: false }], detail };
}

export type Attempt = {
  id: string;
  trial: number;
  pass: boolean;
  rules: Rule[];
  detail: string;
  candidate: string;
  usd: number;
  judge: number;
  priced: boolean;
};

export type Totals = {
  attempts: number;
  passed: number;
  rate: number;
  usd: number;
  judge: number;
  perAttempt: number;
  perPass: number | null;
  priced: boolean;
};

export function totalsOf(attempts: Attempt[]): Totals {
  const passed = attempts.filter((one) => one.pass).length;
  const usd = attempts.reduce((sum, one) => sum + one.usd, 0);
  const judge = attempts.reduce((sum, one) => sum + one.judge, 0);
  return {
    attempts: attempts.length,
    passed,
    rate: attempts.length === 0 ? 0 : passed / attempts.length,
    usd,
    judge,
    perAttempt: attempts.length === 0 ? 0 : usd / attempts.length,
    perPass: passed === 0 ? null : usd / passed,
    priced: attempts.some((one) => one.priced),
  };
}

export function mark(ok: boolean | null): string {
  return ok === null ? "-" : ok ? "pass" : "fail";
}

export function dollars(usd: number, priced: boolean): string {
  return priced ? `$${usd.toFixed(2)}` : "-";
}

export function table(header: string[], rows: string[][]): string {
  const widths = header.map((cell, at) =>
    Math.max(cell.length, ...rows.map((row) => row[at]?.length ?? 0)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, at) => cell.padEnd(widths[at] ?? cell.length))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}
