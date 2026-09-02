/**
 * Reads run files back as scores: for each skill, how often a person took the agent's
 * output as it stood, sent it back for an edit, or dropped it, and whether what the
 * agent wrote is what shipped. Everything here is pure, so the script feeds it text
 * and a repository lookup and the tests feed it fixtures.
 *
 * # The answer key
 *
 * `bun examples/score.ts --key <dir>` writes one file per skill, `<skill>.json`,
 * holding an array of cases, oldest first. A case is one moment a person judged an
 * agent's output, and holds everything a replay needs to run that moment again:
 *
 *   run       the run id holding the turn under test
 *   at        when the judgment landed, ISO 8601
 *   workflow  the workflow whose run held the turn
 *   skill     the skill the turn ran
 *   adapter   the agent adapter, off the usage note the turn's session wrote
 *   model     the model that note named, "unknown" when no note named one
 *   prompt    the first prompt the session sent that skill, exactly as the run file journaled it
 *   prompts   every prompt the session sent that skill before the judgment, in order, so a
 *             replay can send the ticket, then the answers and revisions the person typed
 *   answer    what the person typed at the gate, "" when no gate asked
 *   verdict   "accepted", "edited", or "rejected"
 *   accepted  verdict === "accepted"
 *   artifact  the text the person judged
 *   merged    true, false, or null when the repository can no longer answer
 *   root      the repository the run worked in
 *   branch    the worktree's branch, when the run named one
 *   head      the sha the work started from, when the run recorded one
 *   prHead    the pull request head the review read, when the run recorded one
 *   rounds    rounds to the reviewer's approval, implement only
 *
 * A replay recreates the tree from root plus head or prHead, sends prompts in order to the same
 * skill under another adapter or model, and holds the new answer against artifact.
 *
 * # Where each verdict comes from
 *
 * plan             the "Approve the plan?" gate: approve is as-is, any text is an edit
 * triage           the "Approve the split?" gate, the same two answers
 * review-pr        the "Post this without approving?" gate: send is as-is, text is an edit
 * assess-feedback  the go/skip gate: go as-is, skip dropped, text an edit
 * implement        work's done gate when one judged the run, else the reviewer's own
 *                  rounds: approved first round is as-is, approved later is an edit,
 *                  never approved is dropped. A run stopped before any verdict, with
 *                  nobody's word on it, is no case at all
 * commit           the message went into a commit, so it stood unless open-pr's
 *                  "reply push" gate held it back
 *
 * A gate is read by the question it asked, not by the workflow that asked it, so a
 * workflow that stops calling another and asks inline still scores the same skill.
 *
 * The prompt for an implement case is the first implement turn, the brief as the plan
 * handed it over, because that is what a replay would run again. Its artifact is the
 * acceptance the person checked the tree against, or the reviewer's notes when no
 * person judged it: the tree itself is not journaled, and root plus head recreate it.
 */

export type Entry = Record<string, unknown>;

export type Turn = {
  index: number;
  session: string;
  skill: string;
  prompt: string;
  adapter: string | undefined;
  model: string | undefined;
};

export type Gate = { index: number; at: string; question: string; answer: string };

export type Child = { index: number; id: string; workflow: string };

export type Sha = { index: number; ref: string; sha: string };

/** One run file boiled down to what a score reads, so 150MB of journals fit in memory. */
export type Digest = {
  id: string;
  at: string;
  workflow: string;
  root: string;
  parent: string | undefined;
  outcome: Record<string, unknown> | undefined;
  turns: Turn[];
  gates: Gate[];
  verdicts: string[];
  children: Child[];
  branch: string | undefined;
  head: string | undefined;
  shas: Sha[];
};

export type Verdict = "accepted" | "edited" | "rejected";

export type Case = {
  run: string;
  at: string;
  workflow: string;
  skill: string;
  adapter: string;
  model: string;
  prompt: string;
  prompts: string[];
  answer: string;
  verdict: Verdict;
  accepted: boolean;
  artifact: string;
  merged: boolean | null;
  root: string;
  branch?: string;
  head?: string;
  prHead?: string;
  rounds?: number;
};

/** What git can still say about a run's repository. undefined means the repository is gone. */
export type Repo = {
  subjects(root: string): ReadonlySet<string> | undefined;
  branches(root: string): { all: ReadonlySet<string>; merged: ReadonlySet<string> } | undefined;
};

export type Row = {
  n: number;
  accepted: number;
  edited: number;
  rejected: number;
  measured: number;
  matched: number;
  rounds: number[];
};

export type Bucket = { skill: string; adapter: string; model: string; row: Row };

const PLAN_GATE = "\n\nApprove the plan?";
const TRIAGE_GATE = "\n\nApprove the split?";
const TRIAGE_START = "The ticket splits into ";
const REVIEW_GATE = "\n\nPost this without approving?";
const REVIEW_START = "### Blockers";
const ASSESS_GATE = [
  "\n\ngo does this, skip leaves it. Anything else says what to change about the plan.",
  "\n\nReply go to do this, skip to leave it, or say what to change about the plan.",
];
const ASSESS_START = "### 1.";
const TRIED_GATE = [
  "\n\ndone accepts it. Anything else says what to change.",
  "\n\nReply done, or say what to change.",
];
const TRIED_START = "Try it.\n\n";
const PUSH_START = "Committed: ";
const PUSH_GATE = "reply push to send it to PR";

/**
 * The skills that judge a pull request. A review that reads the tree in one session and
 * judges in another still ends on the judge, so the last of these before a gate is the
 * turn the person's answer is about.
 */
const JUDGE_SKILLS = ["review-pr", "review-judge", "review-gather"];

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function args(entry: Entry): unknown[] {
  const list = entry["args"];
  return Array.isArray(list) ? list : [];
}

function ended(whole: string, ...suffixes: string[]): string | undefined {
  const suffix = suffixes.find((one) => whole.endsWith(one));
  return suffix === undefined ? undefined : whole.slice(0, whole.length - suffix.length);
}

export function workflowName(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return base.endsWith(".ts") ? base.slice(0, -3) : base;
}

export function subjectOf(message: string): string {
  return message.split("\n")[0]?.trim() ?? "";
}

/** One run file as a digest. undefined when the file holds no head entry to read it by. */
export function digest(id: string, file: string): Digest | undefined {
  let head: Entry | undefined;
  let outcome: Record<string, unknown> | undefined;
  const turns: Turn[] = [];
  const gates: Gate[] = [];
  const verdicts: string[] = [];
  const children: Child[] = [];
  const shas: Sha[] = [];
  /** A session runs on one model, so any note it wrote names the whole session's turns. */
  const agents = new Map<string, { adapter?: string; model?: string }>();
  let branch: string | undefined;
  let sha: string | undefined;
  let index = 0;

  for (const line of file.split("\n")) {
    if (line.trim() === "") continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    index++;
    if (head === undefined && "workflow" in entry && "params" in entry) {
      head = entry;
      continue;
    }
    // A resumed run re-journals the calls it replayed. They were judged in the run before.
    if (entry["replayed"] === true) continue;

    const usage = object(entry["usage"]);
    if (usage !== undefined) {
      const session = text(usage["session"]) ?? "";
      const held = agents.get(session) ?? {};
      held.adapter = held.adapter ?? text(usage["adapter"]);
      held.model = held.model ?? text(usage["model"]);
      agents.set(session, held);
      continue;
    }

    const child = text(entry["child"]);
    if (child !== undefined) {
      children.push({ index, id: child, workflow: workflowName(text(entry["workflow"]) ?? "") });
      continue;
    }

    const call = text(entry["call"]);
    if (call === undefined) {
      const value = object(entry["outcome"]);
      if (value !== undefined) outcome = value;
      continue;
    }
    if (entry["pending"] === true) continue;

    if (call === "agent.turn" && entry["handle"] === true) {
      const ask = args(entry)[1];
      const asked = object(ask);
      turns.push({
        index,
        session: text(args(entry)[0]) ?? "",
        skill: text(asked?.["skill"]) ?? "(prompt)",
        prompt: text(asked?.["prompt"]) ?? text(ask) ?? "",
        adapter: undefined,
        model: undefined,
      });
      continue;
    }
    if (call === "view.ask") {
      const question = text(args(entry)[0]);
      const answer = text(entry["outcome"]);
      if (question !== undefined && answer !== undefined) {
        gates.push({ index, at: text(entry["at"]) ?? "", question, answer });
      }
      continue;
    }
    if (call === "view.show") {
      const shown = text(args(entry)[0]) ?? "";
      if (shown.startsWith("verdict: ")) verdicts.push(shown.slice("verdict: ".length));
      continue;
    }
    if (call === "vcs.worktree.add" && branch === undefined) {
      branch = text(args(entry)[0]);
      continue;
    }
    if (call === "vcs.head" && sha === undefined) {
      sha = text(object(entry["outcome"])?.["sha"]);
      continue;
    }
    if (call === "vcs.sha") {
      const found = text(object(entry["outcome"])?.["sha"]);
      if (found !== undefined) shas.push({ index, ref: text(args(entry)[0]) ?? "", sha: found });
    }
  }

  if (head === undefined) return undefined;
  for (const turn of turns) {
    const named = agents.get(turn.session);
    turn.adapter = named?.adapter;
    turn.model = named?.model;
  }
  return {
    id,
    at: text(head["at"]) ?? "",
    workflow: workflowName(text(head["workflow"]) ?? ""),
    root: text(head["root"]) ?? "",
    parent: text(head["parent"]),
    outcome,
    turns,
    gates,
    verdicts,
    children,
    branch,
    head: sha,
    shas,
  };
}

function turnBefore(run: Digest, index: number, skills: string[]): Turn | undefined {
  let found: Turn | undefined;
  for (const turn of run.turns) {
    if (turn.index > index) break;
    if (skills.includes(turn.skill)) found = turn;
  }
  return found;
}

/** The turn a replay would run again: the skill's first, carrying the run's own prompt. */
function firstTurn(run: Digest, skill: string): Turn | undefined {
  return run.turns.find((turn) => turn.skill === skill);
}

function childBefore(
  run: Digest,
  index: number,
  workflow: string,
  runs: Map<string, Digest>,
): Digest | undefined {
  let found: Digest | undefined;
  for (const child of run.children) {
    if (child.index > index) break;
    if (child.workflow !== workflow) continue;
    const held = runs.get(child.id);
    if (held !== undefined) found = held;
  }
  return found;
}

/** The commit the review read: what git called HEAD, since a freshness check also reads FETCH_HEAD. */
function headBefore(run: Digest, index: number): string | undefined {
  let found: string | undefined;
  for (const held of run.shas) {
    if (held.index > index) break;
    if (held.ref === "HEAD") found = held.sha;
  }
  return found;
}

/** A person's word on a child run's work, carried from the parent that asked for it. */
type Judgment = { at: string; answer: string; verdict: Verdict; artifact: string };

function mergedBranch(repo: Repo, root: string, branch: string | undefined): boolean | null {
  if (branch === undefined || branch === "") return null;
  const known = repo.branches(root);
  if (known === undefined) return null;
  // A branch git no longer holds cannot say whether it landed or was thrown away.
  if (!known.all.has(branch)) return null;
  return known.merged.has(branch);
}

function mergedSubject(repo: Repo, root: string, subject: string): boolean | null {
  if (subject === "") return null;
  const subjects = repo.subjects(root);
  return subjects === undefined ? null : subjects.has(subject);
}

function gateCase(
  run: Digest,
  gate: Gate,
  turn: Turn,
  artifact: string,
  verdict: Verdict,
  adapter: string,
): Case {
  const prompts = run.turns
    .filter((held) => held.session === turn.session && held.skill === turn.skill)
    .filter((held) => held.index <= turn.index)
    .map((held) => held.prompt);
  return {
    run: run.id,
    at: gate.at,
    workflow: run.workflow,
    skill: turn.skill,
    adapter: turn.adapter ?? adapter,
    model: turn.model ?? "unknown",
    prompt: prompts[0] ?? turn.prompt,
    prompts,
    answer: gate.answer,
    verdict,
    accepted: verdict === "accepted",
    artifact,
    merged: null,
    root: run.root,
  };
}

/** The gates whose answer is a person's word on a child run, keyed by that run's id. */
function judgmentsOf(runs: Map<string, Digest>): Map<string, Judgment> {
  const judgments = new Map<string, Judgment>();
  for (const run of runs.values()) {
    for (const gate of run.gates) {
      const acceptance = ended(gate.question, ...TRIED_GATE);
      if (acceptance !== undefined && gate.question.startsWith("Task ")) {
        const child = childBefore(run, gate.index, "implement", runs);
        if (child === undefined) continue;
        const start = acceptance.indexOf(TRIED_START);
        judgments.set(child.id, {
          at: gate.at,
          answer: gate.answer,
          verdict: gate.answer === "done" ? "accepted" : "edited",
          artifact: start === -1 ? acceptance : acceptance.slice(start + TRIED_START.length),
        });
        continue;
      }
      if (!gate.question.startsWith(PUSH_START) || !gate.question.includes(PUSH_GATE)) continue;
      const child = childBefore(run, gate.index, "commit", runs);
      if (child === undefined) continue;
      judgments.set(child.id, {
        at: gate.at,
        answer: gate.answer,
        verdict:
          gate.answer === "push" ? "accepted" : gate.answer === "hold" ? "rejected" : "edited",
        artifact: text(child.outcome?.["message"]) ?? "",
      });
    }
  }
  return judgments;
}

/** The case one gate makes, when its question is one a person answered about a skill. */
function gateCases(run: Digest, adapter: string): Case[] {
  const cases: Case[] = [];
  for (const gate of run.gates) {
    const plan = ended(gate.question, PLAN_GATE);
    if (plan !== undefined) {
      const turn = turnBefore(run, gate.index, ["plan"]);
      if (turn === undefined) continue;
      const verdict = gate.answer === "approve" ? "accepted" : "edited";
      cases.push(gateCase(run, gate, turn, plan, verdict, adapter));
      continue;
    }

    const split = ended(gate.question, TRIAGE_GATE);
    if (split !== undefined && gate.question.startsWith(TRIAGE_START)) {
      const turn = turnBefore(run, gate.index, ["triage"]);
      if (turn === undefined) continue;
      const verdict = gate.answer === "approve" ? "accepted" : "edited";
      cases.push(gateCase(run, gate, turn, split, verdict, adapter));
      continue;
    }

    const findings = ended(gate.question, REVIEW_GATE);
    if (findings !== undefined && gate.question.startsWith(REVIEW_START)) {
      const turn = turnBefore(run, gate.index, JUDGE_SKILLS);
      if (turn === undefined) continue;
      const verdict = gate.answer === "send" ? "accepted" : "edited";
      const found = gateCase(run, gate, turn, findings, verdict, adapter);
      const prHead = headBefore(run, gate.index);
      cases.push(prHead === undefined ? found : { ...found, prHead });
      continue;
    }

    const proposal = ended(gate.question, ...ASSESS_GATE);
    if (proposal !== undefined && gate.question.startsWith(ASSESS_START)) {
      const turn = turnBefore(run, gate.index, ["assess-feedback"]);
      if (turn === undefined) continue;
      const verdict =
        gate.answer === "go" ? "accepted" : gate.answer === "skip" ? "rejected" : "edited";
      cases.push(gateCase(run, gate, turn, proposal, verdict, adapter));
    }
  }
  return cases;
}

/** The run itself as a case: the reviewer's rounds, or the commit that stood. */
function runCase(
  run: Digest,
  runs: Map<string, Digest>,
  judgments: Map<string, Judgment>,
  repo: Repo,
  adapter: string,
): Case | undefined {
  const judged = judgments.get(run.id);

  // A run stopped before any verdict and before anyone looked was never judged at all.
  const built = firstTurn(run, "implement");
  if (built !== undefined && (run.verdicts.length > 0 || judged !== undefined)) {
    const approved = run.verdicts.indexOf("approved");
    const parent = run.parent === undefined ? undefined : runs.get(run.parent);
    const branch = parent?.workflow === "work" ? parent.branch : undefined;
    const verdict =
      judged?.verdict ?? (approved === 0 ? "accepted" : approved > 0 ? "edited" : "rejected");
    return {
      run: run.id,
      at: judged?.at ?? run.at,
      workflow: run.workflow,
      skill: "implement",
      adapter: built.adapter ?? adapter,
      model: built.model ?? "unknown",
      prompt: built.prompt,
      prompts: [built.prompt],
      answer: judged?.answer ?? "",
      verdict,
      accepted: verdict === "accepted",
      artifact: judged?.artifact ?? text(run.outcome?.["notes"]) ?? "",
      merged: mergedBranch(repo, run.root, branch),
      root: run.root,
      ...(branch === undefined ? {} : { branch }),
      ...(parent?.head === undefined ? {} : { head: parent.head }),
      ...(approved === -1 ? {} : { rounds: approved + 1 }),
    };
  }

  const wrote = firstTurn(run, "commit");
  if (wrote === undefined || run.outcome?.["committed"] !== true) return undefined;
  const message = text(run.outcome["message"]) ?? "";
  const verdict = judged?.verdict ?? "accepted";
  return {
    run: run.id,
    at: judged?.at ?? run.at,
    workflow: run.workflow,
    skill: "commit",
    adapter: wrote.adapter ?? adapter,
    model: wrote.model ?? "unknown",
    prompt: wrote.prompt,
    prompts: [wrote.prompt],
    answer: judged?.answer ?? "",
    verdict,
    accepted: verdict === "accepted",
    artifact: message,
    merged: mergedSubject(repo, run.root, subjectOf(message)),
    root: run.root,
  };
}

/** Every judged case in the runs, oldest first. `adapter` names the one an unnoted turn ran on. */
export function casesOf(runs: Map<string, Digest>, repo: Repo, adapter: string): Case[] {
  const judgments = judgmentsOf(runs);
  const cases: Case[] = [];
  for (const run of runs.values()) {
    cases.push(...gateCases(run, adapter));
    const found = runCase(run, runs, judgments, repo, adapter);
    if (found !== undefined) cases.push(found);
  }
  return cases.sort((a, b) => a.at.localeCompare(b.at) || a.run.localeCompare(b.run));
}

function fresh(): Row {
  return { n: 0, accepted: 0, edited: 0, rejected: 0, measured: 0, matched: 0, rounds: [] };
}

function count(row: Row, found: Case): void {
  row.n++;
  if (found.verdict === "accepted") row.accepted++;
  if (found.verdict === "edited") row.edited++;
  if (found.verdict === "rejected") row.rejected++;
  if (found.merged !== null) {
    row.measured++;
    if (found.merged) row.matched++;
  }
  if (found.rounds !== undefined) row.rounds.push(found.rounds);
}

/** The cases as one row per skill and per adapter and model, the busiest skill first. */
export function tally(cases: Case[]): Bucket[] {
  const buckets = new Map<string, Bucket>();
  const bySkill = new Map<string, number>();
  for (const found of cases) {
    const key = `${found.skill} ${found.adapter} ${found.model}`;
    const held = buckets.get(key) ?? {
      skill: found.skill,
      adapter: found.adapter,
      model: found.model,
      row: fresh(),
    };
    count(held.row, found);
    buckets.set(key, held);
    bySkill.set(found.skill, (bySkill.get(found.skill) ?? 0) + 1);
  }
  return [...buckets.values()].sort(
    (a, b) =>
      (bySkill.get(b.skill) ?? 0) - (bySkill.get(a.skill) ?? 0) ||
      a.skill.localeCompare(b.skill) ||
      b.row.n - a.row.n ||
      a.adapter.localeCompare(b.adapter) ||
      a.model.localeCompare(b.model),
  );
}

export function totals(cases: Case[]): Row {
  const row = fresh();
  for (const found of cases) count(row, found);
  return row;
}

export function meanRounds(row: Row): number | null {
  if (row.rounds.length === 0) return null;
  return row.rounds.reduce((sum, one) => sum + one, 0) / row.rounds.length;
}

export const HEADER = ["adapter", "model", "n", "as-is", "edited", "rejected", "merged", "rounds"];

export function cells(bucket: Bucket): string[] {
  const { row } = bucket;
  const mean = meanRounds(row);
  return [
    bucket.adapter,
    bucket.model,
    `${row.n}`,
    `${row.accepted}`,
    `${row.edited}`,
    `${row.rejected}`,
    row.measured === 0 ? "-" : `${row.matched}/${row.measured}`,
    mean === null ? "-" : mean.toFixed(1),
  ];
}

export function summary(row: Row): string {
  const merged = row.measured === 0 ? "no merge check" : `${row.matched}/${row.measured} merged`;
  return `total: ${row.n} judged, ${row.accepted} as-is, ${row.edited} edited, ${row.rejected} rejected, ${merged}`;
}
