// Replays the judged review rounds of an answer key through the Jev pass alone and scores where
// it put the files the accepted findings landed on. A change to the probes or the ranking comes
// back as recall against flagged files, in seconds and for cents.
// usage: bun examples/run.ts examples/workflows/jev-exam.ts '{"key":"<dir>","out":"<dir>"}'
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { workflow } from "penguin";
import { z } from "zod";
import type { Report } from "../helpers/jev.ts";
import type { Case } from "../helpers/score.ts";

const PATH = /([\w@./-]+\.(?:tsx?|jsx?|php|md|json|css|scss|html|ya?ml|sql))(?::(\d+))?/g;
/** A window is this many lines, so a finding's line falls in the window that starts at or before it. */
const WINDOW_LINES = 40;
/** How much of a case's prompt the pull request's own text may run. */
const ABOUT_CHARS = 6_000;

type Kind = "blocker" | "non";
type Found = { kind: Kind; text: string; paths: string[]; line: number | null };

type Scored = Found & {
  /** The file the finding lands on is one Jev flagged, or one a flagged file connects to. */
  reached: boolean;
  /** The file is in the diff, and which tier Jev gave it. */
  tier: string | null;
  /** The strongest window over the finding's line, when the finding names one. */
  window: { probe: string; probability: number; rank: number } | null;
};

type Row = {
  pr: string;
  run: string;
  verdict: string;
  secs: number;
  files: number;
  flagged: number;
  findings: Scored[];
  matrix: Report["matrix"];
};

/** The diff as the prompt carried it, for a round git cannot rebuild. */
function diffOf(prompt: string): string {
  const start = prompt.indexOf("\n# Diff\n");
  if (start < 0) return "";
  const body = prompt.slice(start + 8);
  const end = body.search(/\n# (Dossier|Jev screening|Tiers|Connections|Reading order|Already answered)\n/);
  return end < 0 ? body : body.slice(0, end);
}

function aboutOf(prompt: string): string {
  const end = prompt.search(/\n# (Comments|Base)\n/);
  return (end < 0 ? prompt : prompt.slice(0, end)).slice(0, ABOUT_CHARS);
}

function prOf(prompt: string): string {
  return /^# PR #(\d+)/m.exec(prompt)?.[1] ?? "?";
}

function baseOf(prompt: string): string | undefined {
  return /^# Base\n\norigin\/(\S+)/m.exec(prompt)?.[1];
}

/** The base branch GitHub holds for the pull request, for a prompt that never named one. */
function baseFromGithub(root: string, pr: string): string | undefined {
  const ran = spawnSync("gh", ["pr", "view", pr, "--json", "baseRefName", "--jq", ".baseRefName"], {
    cwd: root,
    encoding: "utf8",
  });
  const named = ran.status === 0 ? ran.stdout.trim() : "";
  return named === "" ? undefined : named;
}

/**
 * The diff the round reviewed, rebuilt from git: the prompt carries it cut to what each tier
 * needs, or not at all, and the pass must see the whole change.
 */
function diffFromGit(root: string, base: string, sha: string): string | undefined {
  spawnSync("git", ["-C", root, "fetch", "-q", "origin", base]);
  const ran = spawnSync("git", ["-C", root, "diff", `origin/${base}...${sha}`], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  return ran.status === 0 && ran.stdout !== "" ? ran.stdout : undefined;
}

/** The diff GitHub still serves for a merged pull request whose base branch is gone. */
function diffFromGithub(root: string, pr: string): string | undefined {
  const ran = spawnSync("gh", ["pr", "diff", pr], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  return ran.status === 0 && ran.stdout !== "" ? ran.stdout : undefined;
}

/** The findings the person judged, as the comment listed them: one bullet each, with the paths it names. */
function findingsOf(artifact: string): Found[] {
  const out: Found[] = [];
  let kind: Kind = "blocker";
  for (const line of artifact.split("\n")) {
    if (/^###\s*Non/i.test(line)) kind = "non";
    else if (/^###\s*Block/i.test(line)) kind = "blocker";
    if (!line.startsWith("- ")) continue;
    const found = [...line.matchAll(PATH)].filter((match) => !/^\d/.test(match[1] ?? ""));
    const first = found[0]?.[2];
    out.push({
      kind,
      text: line.slice(2, 140),
      paths: found.map((match) => match[1] ?? ""),
      line: first === undefined ? null : Number(first),
    });
  }
  return out;
}

/** A finding names a file by its full path or by its base name; both match the diff's spelling. */
function same(named: string, spelled: string): boolean {
  return (
    spelled === named ||
    spelled.endsWith(`/${named}`) ||
    path.posix.basename(spelled) === path.posix.basename(named)
  );
}

function windowOver(row: Report["matrix"][number], line: number): Scored["window"] {
  const covering = row.windows.filter((one) => line >= one.line && line < one.line + WINDOW_LINES);
  const best = [...covering].sort((a, b) => b.probability - a.probability)[0];
  if (best === undefined) return null;
  const above = row.windows.filter(
    (one) => one.probability > best.probability && !(line >= one.line && line < one.line + WINDOW_LINES),
  ).length;
  return { probe: best.probe, probability: best.probability, rank: above + 1 };
}

function scored(report: Report, findings: Found[]): { scored: Scored[]; flagged: number } {
  const flagged = [
    ...new Set([...report.findings.map((one) => one.path), ...report.inspected.map((one) => one.path)]),
  ];
  const reach = new Set(
    flagged.flatMap(
      (one) => report.connections.find((held) => held.path === one)?.excerpts.map((excerpt) => excerpt.path) ?? [],
    ),
  );
  return {
    flagged: flagged.length,
    scored: findings.map((finding) => {
      const first = finding.paths[0];
      const row = first === undefined ? undefined : report.matrix.find((one) => same(first, one.path));
      return {
        ...finding,
        reached:
          first !== undefined &&
          (flagged.some((one) => same(first, one)) || [...reach].some((one) => same(first, one))),
        tier: row?.tier ?? null,
        window: row === undefined || finding.line === null ? null : windowOver(row, finding.line),
      };
    }),
  };
}

function count(rows: Row[], pick: (one: Scored) => boolean): number {
  return rows.reduce((sum, row) => sum + row.findings.filter(pick).length, 0);
}

function summary(rows: Row[]): string {
  const located = (one: Scored): boolean => one.paths.length > 0;
  const blocker = (one: Scored): boolean => located(one) && one.kind === "blocker";
  const files = rows.reduce((sum, row) => sum + row.files, 0);
  const flagged = rows.reduce((sum, row) => sum + row.flagged, 0);
  return [
    `rounds ${rows.length}, files ${files}, flagged ${flagged} (${Math.round((100 * flagged) / files)}%)`,
    `findings reached ${count(rows, (one) => located(one) && one.reached)}/${count(rows, located)}`,
    `blockers reached ${count(rows, (one) => blocker(one) && one.reached)}/${count(rows, blocker)}`,
    `blockers in a deep file ${count(rows, (one) => blocker(one) && one.tier === "deep")}/${count(rows, blocker)}`,
  ].join("; ");
}

export default workflow({
  description:
    "replay the judged review rounds of an answer key through the Jev pass alone, and score where it put the files the accepted findings landed on",
  params: z.object({
    key: z.string().describe("the folder examples/score.ts --key wrote"),
    out: z.string().describe("where the results and the scratch checkouts go"),
    prs: z
      .array(z.string())
      .default([])
      .describe("the pull requests to replay, first judged round each, empty for every round"),
    limit: z.number().int().min(1).default(50).describe("how many rounds to replay"),
  }),

  async run({ params, jev, view }) {
    const cases: Case[] = [];
    for (const file of ["review-pr.json", "review-judge.json"]) {
      const held = path.join(params.key, file);
      if (!fs.existsSync(held)) continue;
      cases.push(...(JSON.parse(fs.readFileSync(held, "utf8")) as Case[]));
    }
    const picked = new Set<string>();
    const wanted = cases.filter((one) => {
      if (one.prHead === undefined) return false;
      const pr = prOf(one.prompt);
      if (params.prs.length === 0) return true;
      if (!params.prs.includes(pr) || picked.has(pr)) return false;
      picked.add(pr);
      return true;
    });

    const trees = new Map<string, string>();
    const bases = new Map<string, string | undefined>();
    const rows: Row[] = [];
    try {
      for (const one of wanted.slice(0, params.limit)) {
        const sha = one.prHead ?? "";
        let dir = trees.get(sha);
        if (dir === undefined) {
          dir = path.join(params.out, "trees", sha.slice(0, 10));
          const added = spawnSync("git", ["-C", one.root, "worktree", "add", "--detach", "--force", dir, sha], {
            encoding: "utf8",
          });
          if (added.status !== 0) {
            await view.show(`no checkout for ${sha}: ${added.stderr.trim()}`);
            continue;
          }
          trees.set(sha, dir);
        }
        const pr = prOf(one.prompt);
        const started = Date.now();
        if (!bases.has(pr)) bases.set(pr, baseOf(one.prompt) ?? baseFromGithub(one.root, pr));
        const base = bases.get(pr);
        const diff =
          (base === undefined ? undefined : diffFromGit(one.root, base, sha)) ??
          diffFromGithub(one.root, pr) ??
          diffOf(one.prompt);
        if (diff === "") {
          await view.show(`PR ${pr}: no diff to screen`);
          continue;
        }
        const report = await jev.review({ dir, diff, about: aboutOf(one.prompt) });
        const secs = Math.round((Date.now() - started) / 1000);
        if (report === null) {
          await view.show(`PR ${pr}: nothing to screen`);
          continue;
        }
        const graded = scored(report, findingsOf(one.artifact));
        const row: Row = {
          pr,
          run: one.run,
          verdict: one.verdict,
          secs,
          files: report.files,
          flagged: graded.flagged,
          findings: graded.scored,
          matrix: report.matrix,
        };
        rows.push(row);
        await view.show(`PR ${pr} ${one.verdict} ${secs}s: ${summary([row])}`);
        fs.mkdirSync(params.out, { recursive: true });
        fs.writeFileSync(path.join(params.out, "results.json"), JSON.stringify(rows, null, 2));
      }
    } finally {
      for (const [, dir] of trees) {
        spawnSync("git", ["-C", wanted[0]?.root ?? ".", "worktree", "remove", "--force", dir]);
      }
    }
    await view.show(summary(rows));
    return { rounds: rows.length };
  },
});
