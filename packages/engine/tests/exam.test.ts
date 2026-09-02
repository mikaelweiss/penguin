import { expect, test } from "bun:test";
import {
  attemptRun,
  costOf,
  entriesOf,
  failed,
  gradeCommit,
  gradeFindings,
  gradeImplement,
  gradePlan,
  identify,
  pickCases,
  prefixOf,
  ratesOf,
  recentSubjects,
  sectionOf,
  statusPaths,
  table,
  totalsOf,
  type Attempt,
} from "../examples/helpers/exam.ts";
import type { Case } from "../examples/helpers/score.ts";

function held(extra: Partial<Case> = {}): Case {
  return {
    run: "r1",
    at: "2026-01-01T00:00:00.000Z",
    workflow: "commit",
    skill: "commit",
    adapter: "claude",
    model: "sonnet",
    prompt: "",
    prompts: [],
    answer: "",
    verdict: "accepted",
    accepted: true,
    artifact: "",
    merged: null,
    root: "/repo",
    ...extra,
  };
}

function commitPrompt(status: string[], subjects?: string[]): string {
  const parts = [`<status>\n${status.join("\n")}\n</status>`];
  if (subjects !== undefined) {
    parts.push(`<recent_subjects>\n${subjects.join("\n")}\n</recent_subjects>`);
  }
  return parts.join("\n\n");
}

const STATUS = [" M src/one.ts", "?? src/two.ts", "R  src/three.ts"];

test("a case is named by its run and which of that run's cases it is", () => {
  const named = identify([held({ run: "a" }), held({ run: "b" }), held({ run: "a" })]);

  expect(named.map((one) => one.id)).toEqual(["a#1", "b#1", "a#2"]);
});

test("the newest cases come first, and limit cuts the rest", () => {
  const named = identify([held({ run: "a" }), held({ run: "b" }), held({ run: "c" })]);

  const picked = pickCases(named, { limit: 2, only: [] });

  expect(picked.map((one) => one.id)).toEqual(["c#1", "b#1"]);
});

test("naming a run restricts to every case that run judged", () => {
  const named = identify([held({ run: "a" }), held({ run: "b" }), held({ run: "a" })]);

  const picked = pickCases(named, { limit: 20, only: ["a"] });

  expect(picked.map((one) => one.id)).toEqual(["a#2", "a#1"]);
});

test("naming one case takes that case alone", () => {
  const named = identify([held({ run: "a" }), held({ run: "a" })]);

  const picked = pickCases(named, { limit: 20, only: ["a#1"] });

  expect(picked.map((one) => one.id)).toEqual(["a#1"]);
});

test("the status section names every path, however git spelled the code", () => {
  expect(statusPaths(commitPrompt(STATUS))).toEqual(["src/one.ts", "src/two.ts", "src/three.ts"]);
});

test("a prompt without a section reads as nothing to judge by", () => {
  expect(statusPaths("no sections here")).toEqual([]);
  expect(recentSubjects("no sections here")).toBeUndefined();
  expect(sectionOf("<status>\nM a.ts", "status")).toBeUndefined();
});

test("a subject's prefix is its convention without the issue id", () => {
  expect(prefixOf("SS-59 feat(web): a dialog")).toBe("feat(web)");
  expect(prefixOf("SS-93/SS-94 chore(web): retire the flag")).toBe("chore(web)");
  expect(prefixOf("a subject with no prefix")).toBe("");
});

test("a commit that answers the tree, the style, and the message that shipped passes", () => {
  const prompt = commitPrompt(STATUS, ["SS-1 feat(web): a thing", "SS-1 fix(web): another"]);

  const grade = gradeCommit(
    prompt,
    { files: ["src/one.ts"], subject: "SS-2 fix(web): scope the loader", body: "" },
    "SS-2 fix(web): scope the loader\n\nwhy it is right",
  );

  expect(grade.rules).toEqual([
    { name: "files", ok: true },
    { name: "subject", ok: true },
    { name: "prefix", ok: true },
    { name: "merged", ok: true, counts: false },
  ]);
  expect(grade.pass).toBe(true);
});

test("each commit rule fails on its own", () => {
  const prompt = commitPrompt(STATUS, ["SS-1 feat(web): a thing"]);

  const grade = gradeCommit(
    prompt,
    {
      files: ["src/gone.ts"],
      subject: "SS-2 refactor(api): a subject long enough to run past the fifty character mark.",
      body: "",
    },
    "SS-2 fix(web): scope the loader",
  );

  expect(grade.rules).toEqual([
    { name: "files", ok: false },
    { name: "subject", ok: false },
    { name: "prefix", ok: false },
    { name: "merged", ok: false, counts: false },
  ]);
  expect(grade.pass).toBe(false);
});

test("an answer that commits nothing is not the commit the case recorded", () => {
  const grade = gradeCommit(commitPrompt(STATUS), { files: [], subject: "fix: it", body: "" }, "");

  expect(grade.rules[0]).toEqual({ name: "files", ok: false });
});

test("a prompt that carried no subjects leaves the prefix rule unjudged, and it does not fail", () => {
  const grade = gradeCommit(
    commitPrompt(STATUS),
    { files: ["src/one.ts"], subject: "fix: scope the loader", body: "" },
    "fix: scope the loader",
  );

  expect(grade.rules.map((rule) => rule.ok)).toEqual([true, true, null, true]);
  expect(grade.pass).toBe(true);
});

test("a subject that ends in a period does not read as a subject", () => {
  const grade = gradeCommit(
    commitPrompt(STATUS),
    { files: ["src/one.ts"], subject: "fix: scope the loader.", body: "" },
    "fix: scope the loader.",
  );

  expect(grade.rules[1]).toEqual({ name: "subject", ok: false });
});

test("a plan the judge calls equivalent passes, and what it missed is the detail", () => {
  expect(gradePlan({ equivalent: true, missing: [], extra: [] })).toEqual({
    pass: true,
    rules: [{ name: "equivalent", ok: true }],
    detail: "same work",
  });

  const grade = gradePlan({ equivalent: false, missing: ["the migration"], extra: ["a rewrite"] });

  expect(grade.pass).toBe(false);
  expect(grade.detail).toBe("missing: the migration | extra: a rewrite");
});

test("findings the person took have to be found again", () => {
  const found = gradeFindings({ matched: ["a", "b"], missed: [], invented: ["c"] }, "accepted");
  const short = gradeFindings({ matched: ["a"], missed: ["b"], invented: [] }, "accepted");

  expect(found.pass).toBe(true);
  expect(found.rules).toEqual([{ name: "found", ok: true }]);
  expect(short.pass).toBe(false);
  expect(short.detail).toBe("recall 50%, precision 100% | missed: b");
});

test("findings the person dropped fail when the candidate finds them again", () => {
  const again = gradeFindings({ matched: ["a"], missed: [], invented: [] }, "rejected");
  const clean = gradeFindings({ matched: [], missed: ["a"], invented: ["b"] }, "rejected");

  expect(again.pass).toBe(false);
  expect(again.rules).toEqual([{ name: "dropped", ok: false }]);
  expect(clean.pass).toBe(true);
});

test("precision and recall have no value when nothing was offered or recorded", () => {
  expect(ratesOf({ matched: [], missed: [], invented: [] })).toEqual({
    recall: null,
    precision: null,
  });
});

test("an implementation passes on green gates and an approval", () => {
  expect(gradeImplement(true, "approved", "").pass).toBe(true);
  expect(gradeImplement(false, "approved", "").rules[0]).toEqual({ name: "gates", ok: false });

  const sent = gradeImplement(true, "changes_needed", "src/one.ts:10 drops the error");

  expect(sent.pass).toBe(false);
  expect(sent.detail).toBe("changes_needed: src/one.ts:10 drops the error");
});

test("an attempt that never ran is a failure with the reason as its detail", () => {
  expect(failed("no worktree")).toEqual({
    pass: false,
    rules: [{ name: "ran", ok: false }],
    detail: "no worktree",
  });
});

test("a run's cost counts the grader's turns apart from the rest", () => {
  const entries = entriesOf(
    [
      JSON.stringify({ usage: { session: "s1", skill: "commit", usd: 0.1, input: 10 } }),
      "",
      JSON.stringify({ usage: { session: "s2", skill: "exam-judge-plan", usd: 0.05, input: 10 } }),
      "not json",
    ].join("\n"),
  );

  const cost = costOf(entries);

  expect(cost.usd).toBeCloseTo(0.15);
  expect(cost.judge).toBeCloseTo(0.05);
  expect(cost.priced).toBe(true);
});

test("a run with no priced usage says so", () => {
  const entries = entriesOf(JSON.stringify({ usage: { session: "s1", input: 10 } }));

  expect(costOf(entries)).toEqual({ usd: 0, judge: 0, priced: false });
});

test("an attempt's run is the newest one it started that names the case", () => {
  const runs = [
    { id: "2026-01-01T00-00-00.000Z-1", head: { params: { only: "a#1", trial: 1 } } },
    { id: "2026-01-03T00-00-00.000Z-1", head: { params: { only: "a#1", trial: 1 } } },
    { id: "2026-01-03T00-00-00.000Z-2", head: { params: { only: "a#1", trial: 2 } } },
    { id: "2026-01-03T00-00-00.000Z-3", head: { params: { only: "b#1", trial: 1 } } },
    { id: "2026-01-03T00-00-00.000Z-4", head: {} },
  ];

  expect(attemptRun(runs, "2026-01-02", "a#1", 1)).toBe("2026-01-03T00-00-00.000Z-1");
  expect(attemptRun(runs, "2026-01-02", "a#1", 3)).toBeUndefined();
});

function attempt(pass: boolean, usd: number, judge: number): Attempt {
  return {
    id: "a#1",
    trial: 1,
    pass,
    rules: [],
    detail: "",
    candidate: "",
    usd,
    judge,
    priced: true,
  };
}

test("the totals say the pass rate, the cost per case, and the cost per passed case", () => {
  const total = totalsOf([attempt(true, 0.2, 0.05), attempt(false, 0.2, 0.05)]);

  expect(total.passed).toBe(1);
  expect(total.rate).toBe(0.5);
  expect(total.perAttempt).toBeCloseTo(0.2);
  expect(total.perPass).toBeCloseTo(0.4);
  expect(total.judge).toBeCloseTo(0.1);
});

test("nothing passed leaves no cost per passed case", () => {
  expect(totalsOf([attempt(false, 0.2, 0)]).perPass).toBeNull();
  expect(totalsOf([]).rate).toBe(0);
});

test("a table lines its columns up on the widest cell", () => {
  expect(table(["case", "usd"], [["a#1", "$0.10"], ["longer", "-"]])).toBe(
    "case    usd\na#1     $0.10\nlonger  -",
  );
});

test("the issue id in front of a subject does not count against its length", () => {
  const prompt = commitPrompt(STATUS, ["SS-1 feat(web): a thing"]);
  const grade = gradeCommit(
    prompt,
    { files: ["src/one.ts"], subject: "SS-1234 feat(web): a subject of forty-six chars", body: "" },
    "",
  );
  expect(grade.rules.find((rule) => rule.name === "subject")?.ok).toBe(true);
});

test("a subject that differs from the one that shipped is reported, and it does not fail", () => {
  const prompt = commitPrompt(STATUS, ["SS-1 feat(web): a thing"]);
  const grade = gradeCommit(
    prompt,
    { files: ["src/one.ts"], subject: "SS-2 feat(web): name it another way", body: "" },
    "SS-2 feat(web): name it one way",
  );
  expect(grade.rules.find((rule) => rule.name === "merged")?.ok).toBe(false);
  expect(grade.pass).toBe(true);
});
