import { expect, test } from "bun:test";
import {
  casesOf,
  cells,
  digest,
  meanRounds,
  subjectOf,
  summary,
  tally,
  totals,
  workflowName,
  type Case,
  type Digest,
  type Repo,
} from "../examples/helpers/score.ts";

const ROOT = "/repo";

function jsonl(entries: Record<string, unknown>[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function head(id: string, workflow: string, extra: Record<string, unknown> = {}) {
  return {
    at: "2026-01-01T00:00:00.000Z",
    run: id,
    pid: 1,
    workflow: `/w/examples/workflows/${workflow}.ts`,
    params: {},
    cwd: ROOT,
    root: ROOT,
    ...extra,
  };
}

function turn(session: string, skill: string, prompt: string) {
  return { at: "t", call: "agent.turn", args: [session, { skill, prompt }], handle: true };
}

function usage(session: string, note: Record<string, unknown>) {
  return { at: "t", usage: { adapter: "claude", session, ...note } };
}

function ask(question: string, outcome: string, at = "2026-01-01T00:00:00.000Z") {
  return { at, call: "view.ask", args: [question], id: "c1", elapsedMs: 1, outcome };
}

function show(what: string) {
  return { at: "t", call: "view.show", args: [what], sync: true, outcome: undefined };
}

const NO_REPO: Repo = { subjects: () => undefined, branches: () => undefined };

function repoWith(subjects: string[], all: string[], merged: string[]): Repo {
  return {
    subjects: () => new Set(subjects),
    branches: () => ({ all: new Set(all), merged: new Set(merged) }),
  };
}

function digested(files: [string, Record<string, unknown>[]][]): Map<string, Digest> {
  const runs = new Map<string, Digest>();
  for (const [id, entries] of files) {
    const read = digest(id, jsonl(entries));
    if (read !== undefined) runs.set(id, read);
  }
  return runs;
}

function only(cases: Case[], skill: string): Case[] {
  return cases.filter((found) => found.skill === skill);
}

test("a file with no head entry is no run", () => {
  expect(digest("r", jsonl([{ at: "t", call: "view.show", args: ["hi"] }]))).toBeUndefined();
  expect(digest("r", "")).toBeUndefined();
  expect(digest("r", jsonl([head("r", "plan")]))?.workflow).toBe("plan");
});

test("a turn takes the adapter and model off any note its session wrote", () => {
  const read = digest(
    "r",
    jsonl([
      head("r", "review-pr"),
      turn("s1", "review-judge", "judge it"),
      // A stopped turn reports nothing, so the model comes from the note that named one.
      usage("s1", { skill: "review-judge", input: 0, output: 0 }),
      turn("s1", "review-judge", "judge it again"),
      usage("s1", { skill: "review-judge", model: "claude-opus-5", input: 9, output: 3 }),
      turn("s2", "review-gather", "read it"),
    ]),
  );

  expect(read?.turns.map((one) => [one.skill, one.model])).toEqual([
    ["review-judge", "claude-opus-5"],
    ["review-judge", "claude-opus-5"],
    ["review-gather", undefined],
  ]);
  expect(read?.turns[0]?.adapter).toBe("claude");
});

test("a resumed run's replayed calls are not judged again", () => {
  const read = digest(
    "r",
    jsonl([
      head("r", "plan"),
      { ...ask("the plan\n\nApprove the plan?", "approve"), replayed: true },
      ask("the plan\n\nApprove the plan?", "approve"),
    ]),
  );

  expect(read?.gates).toHaveLength(1);
});

test("a run reads its shas by the ref git was asked for", () => {
  const read = digest(
    "r",
    jsonl([
      head("r", "review-pr"),
      { at: "t", call: "vcs.sha", args: ["HEAD"], id: "c1", outcome: { sha: "aaa" } },
      { at: "t", call: "vcs.sha", args: ["FETCH_HEAD"], id: "c2", outcome: { sha: "bbb" } },
    ]),
  );

  expect(read?.shas.map((one) => [one.ref, one.sha])).toEqual([
    ["HEAD", "aaa"],
    ["FETCH_HEAD", "bbb"],
  ]);
});

test("the plan gate says whether the plan stood, whatever workflow asked it", () => {
  const runs = digested([
    [
      "a",
      [
        head("a", "plan"),
        turn("s", "plan", "plan the ticket"),
        usage("s", { skill: "plan", model: "claude-opus-5" }),
        ask("the plan\n\nApprove the plan?", "approve", "2026-01-01T00:00:00.000Z"),
      ],
    ],
    // The same gate, asked inline by work rather than by a plan run of its own.
    [
      "b",
      [
        head("b", "work"),
        turn("s", "plan", "plan the task"),
        ask("another plan\n\nApprove the plan?", "cut the second step", "2026-01-02T00:00:00.000Z"),
      ],
    ],
  ]);

  const found = only(casesOf(runs, NO_REPO, "codex"), "plan");
  expect(found.map((one) => [one.workflow, one.verdict, one.model, one.artifact])).toEqual([
    ["plan", "accepted", "claude-opus-5", "the plan"],
    ["work", "edited", "unknown", "another plan"],
  ]);
  // A turn with no usage note falls back to the adapter the config names.
  expect(found[1]?.adapter).toBe("codex");
  expect(found[1]?.answer).toBe("cut the second step");
});

test("the triage gate scores the split, and a clarifying question is not a gate", () => {
  const runs = digested([
    [
      "a",
      [
        head("a", "triage"),
        turn("s", "triage", "triage the ticket"),
        ask("Which flag does this mean?", "the react one"),
        ask("The ticket splits into 2 tasks:\n\n1. one\n2. two\n\nApprove the split?", "approve"),
      ],
    ],
  ]);

  const found = only(casesOf(runs, NO_REPO, "claude"), "triage");
  expect(found).toHaveLength(1);
  expect(found[0]?.verdict).toBe("accepted");
  expect(found[0]?.prompt).toBe("triage the ticket");
});

test("the review gate belongs to the judge, and carries the PR head the review read", () => {
  const runs = digested([
    [
      "a",
      [
        head("a", "review-pr"),
        turn("s1", "review-gather", "read the tree"),
        { at: "t", call: "vcs.sha", args: ["HEAD"], id: "c1", outcome: { sha: "deadbeef" } },
        turn("s2", "review-judge", "judge the PR"),
        usage("s2", { skill: "review-judge", model: "claude-opus-5" }),
        { at: "t", call: "vcs.sha", args: ["FETCH_HEAD"], id: "c2", outcome: { sha: "other" } },
        ask("### Blockers\n\n- one\n\nPost this without approving?", "send"),
      ],
    ],
  ]);

  const found = only(casesOf(runs, NO_REPO, "claude"), "review-judge");
  expect(found[0]?.verdict).toBe("accepted");
  expect(found[0]?.prompt).toBe("judge the PR");
  expect(found[0]?.prHead).toBe("deadbeef");
  expect(found[0]?.artifact).toBe("### Blockers\n\n- one");
});

test("the assess-feedback gate splits go, skip, and a change", () => {
  const gate =
    "\n\nReply go to do this, skip to leave it, or say what to change about the plan.";
  const runs = digested([
    [
      "a",
      [
        head("a", "open-pr"),
        turn("s", "assess-feedback", "assess the threads"),
        ask(`### 1. a blocker${gate}`, "go", "2026-01-01T00:00:00.000Z"),
        ask(`### 1. a second${gate}`, "skip", "2026-01-02T00:00:00.000Z"),
        ask(`### 1. a third${gate}`, "answer thread two instead", "2026-01-03T00:00:00.000Z"),
      ],
    ],
  ]);

  const found = only(casesOf(runs, NO_REPO, "claude"), "assess-feedback");
  expect(found.map((one) => one.verdict)).toEqual(["accepted", "rejected", "edited"]);
  expect(found.map((one) => one.accepted)).toEqual([true, false, false]);
});

/** A work run with one implement child, the child's own verdicts, and the gate that judged it. */
function workTree(options: {
  verdicts: string[];
  answer: string;
  branch: string;
}): Map<string, Digest> {
  return digested([
    [
      "parent",
      [
        head("parent", "work"),
        {
          at: "t",
          call: "vcs.worktree.add",
          args: [options.branch, { from: "origin/main" }],
          id: "c1",
          outcome: { path: `/wt/${options.branch}`, existed: false },
        },
        { at: "t", call: "vcs.head", args: [{ cwd: "/wt" }], id: "c2", outcome: { sha: "base1" } },
        { at: "t", child: "child", workflow: "/w/examples/workflows/implement.ts" },
        ask(
          `Task 1 of 1 is in /wt. Try it.\n\nthe acceptance\n\nReply done, or say what to change.`,
          options.answer,
        ),
      ],
    ],
    [
      "child",
      [
        head("child", "implement", { parent: "parent" }),
        turn("s", "implement", "the brief"),
        usage("s", { skill: "implement", model: "claude-fable-5-1" }),
        ...options.verdicts.map((verdict) => show(`verdict: ${verdict}`)),
        { at: "t", outcome: { approved: true, blocking: "", notes: "the notes" } },
      ],
    ],
  ]);
}

test("an implement run is judged by the person who tried it, over the reviewer's rounds", () => {
  const repo = repoWith([], ["feature"], ["feature"]);
  const runs = workTree({ verdicts: ["changes_needed", "approved"], answer: "done", branch: "feature" });

  const found = only(casesOf(runs, repo, "claude"), "implement");
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({
    verdict: "accepted",
    answer: "done",
    model: "claude-fable-5-1",
    prompt: "the brief",
    artifact: "the acceptance",
    rounds: 2,
    branch: "feature",
    head: "base1",
    merged: true,
  });
});

test("an unjudged implement run is scored by the round its review approved on", () => {
  const cases = (verdicts: string[]): Case[] => {
    const runs = digested([
      [
        "child",
        [
          head("child", "implement"),
          turn("s", "implement", "the brief"),
          ...verdicts.map((verdict) => show(`verdict: ${verdict}`)),
          { at: "t", outcome: { approved: true, blocking: "", notes: "the notes" } },
        ],
      ],
    ]);
    return only(casesOf(runs, NO_REPO, "claude"), "implement");
  };

  expect(cases(["approved"])[0]).toMatchObject({ verdict: "accepted", rounds: 1, artifact: "the notes" });
  expect(cases(["changes_needed", "approved"])[0]).toMatchObject({ verdict: "edited", rounds: 2 });
  expect(cases(["changes_needed", "changes_needed"])[0]?.verdict).toBe("rejected");
  expect(cases(["changes_needed", "changes_needed"])[0]?.rounds).toBeUndefined();
  // A run stopped before any verdict, with nobody's word on it, was never judged.
  expect(cases([])).toHaveLength(0);
});

test("a branch git no longer holds cannot say whether the work landed", () => {
  const gone = workTree({ verdicts: ["approved"], answer: "done", branch: "feature" });
  expect(only(casesOf(gone, repoWith([], ["main"], ["main"]), "claude"), "implement")[0]?.merged).toBeNull();
  expect(only(casesOf(gone, NO_REPO, "claude"), "implement")[0]?.merged).toBeNull();

  const open = repoWith([], ["main", "feature"], ["main"]);
  expect(only(casesOf(gone, open, "claude"), "implement")[0]?.merged).toBe(false);
});

test("a commit stands unless the push gate held it, and merges when its subject shipped", () => {
  const commitRun = (id: string): Record<string, unknown>[] => [
    head(id, "commit"),
    turn("s", "commit", "the tree"),
    usage("s", { skill: "commit", model: "claude-sonnet-5" }),
    { at: "t", outcome: { committed: true, message: "fix: land it\n\nwhy it is right" } },
  ];
  const runs = digested([
    ["c1", commitRun("c1")],
    ["c2", commitRun("c2")],
    [
      "parent",
      [
        head("parent", "open-pr"),
        { at: "t", child: "c2", workflow: "/w/examples/workflows/commit.ts" },
        ask(
          "Committed: fix: land it\n\nCheck it, then reply push to send it to PR #7, hold to leave it here, or say what to fix first.",
          "rename it",
          "2026-01-02T00:00:00.000Z",
        ),
      ],
    ],
  ]);

  const found = only(casesOf(runs, repoWith(["fix: land it"], [], []), "claude"), "commit");
  expect(found.map((one) => [one.run, one.verdict, one.merged])).toEqual([
    ["c1", "accepted", true],
    ["c2", "edited", true],
  ]);
  expect(found[0]?.model).toBe("claude-sonnet-5");
  expect(subjectOf("fix: land it\n\nwhy")).toBe("fix: land it");
});

test("a commit that never landed is no case, and an unmeasurable one stays null", () => {
  const runs = digested([
    [
      "c1",
      [
        head("c1", "commit"),
        turn("s", "commit", "the tree"),
        { at: "t", outcome: { committed: false, message: "fix: nothing" } },
      ],
    ],
    [
      "c2",
      [
        head("c2", "commit"),
        turn("s", "commit", "the tree"),
        { at: "t", outcome: { committed: true, message: "fix: shipped" } },
      ],
    ],
  ]);

  const found = only(casesOf(runs, NO_REPO, "claude"), "commit");
  expect(found.map((one) => [one.run, one.merged])).toEqual([["c2", null]]);
});

test("the rows split by skill, adapter and model, and the totals add them up", () => {
  const base: Case = {
    run: "r",
    at: "2026-01-01T00:00:00.000Z",
    workflow: "plan",
    skill: "plan",
    adapter: "claude",
    model: "claude-opus-5",
    prompt: "p",
    prompts: ["p"],
    answer: "approve",
    verdict: "accepted",
    accepted: true,
    artifact: "a",
    merged: null,
    root: ROOT,
  };
  const cases: Case[] = [
    base,
    { ...base, verdict: "edited", accepted: false },
    { ...base, model: "claude-sonnet-5", verdict: "rejected", accepted: false },
    { ...base, skill: "implement", merged: true, rounds: 1 },
    { ...base, skill: "implement", merged: false, rounds: 3 },
  ];

  const rows = tally(cases);
  expect(rows.map((one) => [one.skill, one.model, one.row.n])).toEqual([
    ["plan", "claude-opus-5", 2],
    ["plan", "claude-sonnet-5", 1],
    ["implement", "claude-opus-5", 2],
  ]);
  expect(cells(rows[0]!)).toEqual(["claude", "claude-opus-5", "2", "1", "1", "0", "-", "-"]);
  expect(cells(rows[2]!)).toEqual(["claude", "claude-opus-5", "2", "2", "0", "0", "1/2", "2.0"]);

  const all = totals(cases);
  expect(meanRounds(all)).toBe(2);
  expect(summary(all)).toBe("total: 5 judged, 3 as-is, 1 edited, 1 rejected, 1/2 merged");
  expect(summary(totals([base]))).toContain("no merge check");
});

test("a workflow is named by its file", () => {
  expect(workflowName("/a/b/review-pr.ts")).toBe("review-pr");
  expect(workflowName("plan")).toBe("plan");
});

test("a plan case carries every prompt its session sent, so a replay can send the answers too", () => {
  const runs = digested([
    [
      "a",
      [
        head("a", "plan"),
        turn("s", "plan", "plan the ticket"),
        usage("s", { skill: "plan", model: "claude-opus-5" }),
        turn("s", "plan", "# Answers\n\nthe react one"),
        usage("s", { skill: "plan", model: "claude-opus-5" }),
        ask("the plan\n\nApprove the plan?", "approve", "2026-01-01T00:00:00.000Z"),
      ],
    ],
  ]);

  const found = only(casesOf(runs, NO_REPO, "claude"), "plan");
  expect(found[0]?.prompt).toBe("plan the ticket");
  expect(found[0]?.prompts).toEqual(["plan the ticket", "# Answers\n\nthe react one"]);
});
