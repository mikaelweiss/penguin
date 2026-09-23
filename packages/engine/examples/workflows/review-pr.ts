import fs from "node:fs";
import path from "node:path";
import { attempt, messageOf, workflow } from "penguin";
import { z } from "zod";
import { diffFor, reading, type Report } from "../helpers/jev.ts";
import { narrate } from "../helpers/turns.ts";
import { openWorktree } from "../helpers/worktree.ts";

/** What every review worktree is named under, and what the sweep reads a PR number back out of. */
const PREFIX = "review-pr-";

/** What the comment carrying the overview holds, so a run that starts over reads it off the PR. */
const OVERVIEW_MARK = "<!-- penguin:overview -->";

/**
 * How sure the evidence check must be before its answer counts. Below it the claim stands as
 * the reviewer wrote it, because an unsure check is no evidence either way.
 */
const SETTLED = 0.7;

/** One finding: what is wrong, and the code it rests on, so the claim can be checked. */
const Claimed = z.object({
  claim: z.string().describe("what is wrong and why it matters, in one line"),
  where: z
    .string()
    .describe(
      "the file and line the claim rests on, as path:line, or the path when no one line carries it",
    ),
});

const Behavior = z.object({
  before: z.string().describe("what happens for the user today, eight words or fewer"),
  after: z.string().describe("what happens for the user after this change, eight words or fewer"),
});

const Flow = z.object({
  name: z.string().describe("what the flow does, as a person would say it"),
  steps: z
    .array(z.string().describe("one action to take and what to see, in one sentence"))
    .describe("how to reach the flow in the product and what should happen, in order"),
});

export const Findings = z.object({
  behaviors: z
    .array(Behavior)
    .describe("every behavior this change adds, removes, or alters, in reading order"),
  flows: z.array(Flow).describe("the user flows the change touches, each with the steps that test it"),
  blockers: z.array(Claimed).describe("the issues that must change before an approve"),
  nonBlockers: z.array(Claimed).describe("the improvements the author may take or leave"),
});

type Claimed = z.infer<typeof Claimed>;
export type Findings = z.infer<typeof Findings>;
type Note = { author: string; at: string; body: string };

function listed(items: string[]): string {
  return items.length === 0 ? "none" : items.map((item) => `- ${item}`).join("\n");
}

function claimed(claims: Claimed[]): string {
  return listed(claims.map((one) => `${one.claim} (\`${one.where}\`)`));
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function behaviors(found: Findings["behaviors"]): string {
  if (found.length === 0) return "none";
  const rows = found.map((one) => `| ${cell(one.before)} | ${cell(one.after)} |`);
  return ["| Before | After |", "| --- | --- |", ...rows].join("\n");
}

function flows(found: Findings["flows"]): string {
  if (found.length === 0) return "none";
  return found
    .map((one) => `**${one.name}**\n\n${one.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`)
    .join("\n\n");
}

/** What the change does and how to try it. The PR hears it once, on the first comment posted. */
function overview(findings: Findings): string {
  return [
    `### What changes\n\n${behaviors(findings.behaviors)}`,
    `### How to test\n\n${flows(findings.flows)}`,
  ].join("\n\n");
}

/** What the author must and may change. Every comment carries it. */
function verdict(findings: Findings): string {
  return [
    `### Blockers\n\n${claimed(findings.blockers)}`,
    `### Non-blockers\n\n${claimed(findings.nonBlockers)}`,
  ].join("\n\n");
}

/** The findings in full, as the first comment on a PR carries them. */
export function report(findings: Findings): string {
  return `${overview(findings)}\n\n${verdict(findings)}`;
}

function noted(notes: Note[]): string {
  return notes.map((note) => `## ${note.author} on ${note.at}\n\n${note.body}`).join("\n\n");
}

/** The paths a unified diff touches, in the order it names them. */
function touched(diff: string): string[] {
  const paths: string[] = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const named = line.slice(4).trim();
    if (named === "/dev/null") continue;
    paths.push(named.startsWith("b/") ? named.slice(2) : named);
  }
  return paths;
}

/** What the reviewer would otherwise spend its first calls rebuilding: the base, the files, the diff. */
function changed(base: string, diff: string): string {
  const files = touched(diff);
  const listed = files.length === 0 ? "none read" : files.map((file) => `- ${file}`).join("\n");
  return `# Base\n\norigin/${base}\n\n# Changed files\n\n${listed}\n\n# Diff\n\n${diff}`;
}

/** Jev's map of the change, for a reviewer that would otherwise read every file the same way. */
function mapped(report: Report | null, dir: string): string {
  if (report === null) return "";
  const read = (file: string): string | undefined => {
    try {
      return fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      return undefined;
    }
  };
  const map = reading(report, read);
  return map === "" ? "" : `\n\n${map}`;
}

export default workflow({
  description:
    "review an open pull request: triage it first, post the findings, approve when nothing blocks, and re-review every push until it merges or closes",
  params: z.object({ pr: z.string().describe("the pull request, as a number or a url") }),

  async run(ctx) {
    const { params, agent, vcs, github, jev, view } = ctx;
    const found = await github.pr.get(params.pr);
    if (found === null) {
      await view.show(`${params.pr} names no pull request`);
      return { rounds: 0, posted: 0 };
    }
    let pr = found;
    if (pr.state !== "OPEN") {
      await view.show(`PR #${pr.number} is ${pr.state}, nothing to review`);
      return { rounds: 0, posted: 0 };
    }

    let description = pr.body;
    let notes: Note[] = await github.pr.comments(params.pr);

    /** The PR as it stands now, not as a gate's answer left it. False means it is no longer reviewable. */
    const reread = async (): Promise<boolean> => {
      const again = await github.pr.get(params.pr);
      if (again === null) {
        await view.show(`PR #${pr.number} no longer reads, nothing to review`);
        return false;
      }
      pr = again;
      description = pr.body;
      notes = await github.pr.comments(params.pr);
      if (pr.state === "OPEN") return true;
      await view.show(`PR #${pr.number} is ${pr.state}, nothing to review`);
      return false;
    };

    const briefing = (): string => {
      const conversation = notes.length === 0 ? "" : `\n\n# Comments\n\n${noted(notes)}`;
      return `# PR #${pr.number}: ${pr.title}\n\n${pr.url}\n\n${description}${conversation}`;
    };

    // The triage reads the diff over the wire, so a PR the user takes costs no worktree.
    let diff = await github.pr.diff(params.pr);
    /** Jev's word on whether a person reads this in a minute. A failure means the full review, which is what the judgment guards. */
    const triaged = await (async (): Promise<{ eyeball: boolean; reason: string }> => {
      try {
        return await jev.triage.pr({ title: pr.title, description, notes, diff });
      } catch (error) {
        await view.show(`The Jev triage did not run, so the full review does: ${messageOf(error)}`);
        return { eyeball: false, reason: "" };
      }
    })();
    if (triaged.eyeball) {
      const choice = await view.ask(
        `PR #${pr.number} is small enough to read yourself: ${triaged.reason}\n\n${pr.url}\n\nreview runs the full review, mine leaves it to you.`,
        z.enum(["review", "mine"]),
      );
      if (choice === "mine") {
        await view.show(`PR #${pr.number} is yours to read`);
        return { rounds: 0, posted: 0 };
      }
      // The gate can sit for hours, so the review reads the PR again rather than the triage's copy.
      if (!(await reread())) return { rounds: 0, posted: 0 };
    }

    const ref = `pull/${pr.number}/head`;
    const name = `${PREFIX}${pr.number}`;

    /**
     * What earlier reviews left behind. A run killed between its review and the merge never
     * reaches its own teardown, so each review clears the trees whose pull requests are done.
     */
    const sweep = async (): Promise<void> => {
      let held: { path: string; name: string }[];
      try {
        held = await vcs.worktree.list();
      } catch {
        return;
      }
      for (const tree of held) {
        if (tree.name === name || !tree.name.startsWith(PREFIX)) continue;
        const number = tree.name.slice(PREFIX.length);
        if (!/^\d+$/.test(number)) continue;
        try {
          const done = await github.pr.get(number);
          if (done !== null && done.state === "OPEN") continue;
          await vcs.worktree.remove(tree.path, { force: true });
          await view.show(`swept the worktree for PR #${number}: it is ${done?.state ?? "gone"}`);
        } catch (error) {
          await view.show(`the worktree for PR #${number} stayed: ${messageOf(error)}`);
        }
      }
    };
    await sweep();

    const changes = github.pr.changes(params.pr);
    let inbound = changes.next();
    let previous: Findings | undefined;
    let inDraft = pr.isDraft;
    let paused = pr.isInMergeQueue;
    let owed = true;
    let rounds = 0;
    let posted = 0;
    let introduced = false;
    let head = "";
    let dir = "";
    let reviewer = "";

    type Change = Awaited<ReturnType<typeof changes.next>>;
    type Stop = "approved" | "closed" | "draft" | "queued" | "stale";
    type Ran<T> = { stop: Stop } | { value: T };

    const opened = (): Promise<string> => agent.open({ cwd: dir, autocompact: "200000" });

    /** The tree a round reads, cut when one is owed. The reviewer opens on it and dies with it. */
    const hold = async (): Promise<boolean> => {
      if (dir !== "") return true;
      const cut = await openWorktree(ctx, name, { ref });
      if (cut === "") return false;
      dir = cut;
      reviewer = await opened();
      return true;
    };

    /**
     * A full checkout costs too much to hold through a wait that runs for days, and a review
     * with nothing owed has no use for one. Teardown runs here too, so it runs on every exit.
     */
    const drop = async (): Promise<void> => {
      if (dir === "") return;
      const held = dir;
      dir = "";
      reviewer = "";
      head = "";
      // Best-effort teardown: the review's outcome must not wait on a gate about a folder.
      try {
        await attempt(() => vcs.worktree.remove(held, { force: true }));
      } catch (error) {
        await view.show(`the worktree stayed: ${messageOf(error)}`);
      }
    };

    const opening = (map: string, shown: string): string =>
      previous === undefined
        ? `Review this pull request. The working tree holds its code.\n\n${briefing()}\n\n${changed(pr.baseRefName, shown)}${map}`
        : `New code arrived since the last review, and the working tree holds it. The last review found:\n\n${report(previous)}\n\nCheck whether each finding still holds, review what changed, and return the full updated findings.\n\n${briefing()}\n\n${changed(pr.baseRefName, shown)}${map}`;

    // The worktree only mirrors the PR head, so a force-push is a reset, not a merge.
    const synced = async (): Promise<void> => {
      await vcs.fetch(ref, { cwd: dir });
      await vcs.resetHard("FETCH_HEAD", { cwd: dir });
      head = (await vcs.sha("HEAD", { cwd: dir })).sha;
      // The diff the reviewer reads must be the code the tree now holds.
      diff = await github.pr.diff(params.pr);
    };

    /** The commit the findings judge, against the commit the PR carries now. */
    const since = async (): Promise<"same" | "moved" | "unread"> => {
      if (dir === "" || head === "") return "unread";
      // A freshness read stays best-effort: a fault here must not hold the review at a gate.
      try {
        return await attempt(async () => {
          await vcs.fetch(ref, { cwd: dir });
          const now = await vcs.sha("FETCH_HEAD", { cwd: dir });
          return now.sha === head ? "same" : "moved";
        });
      } catch {
        return "unread";
      }
    };

    /** A gate the user answers late must not post a verdict on code the review never read. */
    const overtaken = async (): Promise<boolean> => {
      const state = await since();
      if (state === "unread") {
        await view.show("Git did not name the PR head, so this stands on the code the review read.");
        return false;
      }
      if (state === "same") return false;
      await view.show(
        `New code landed on PR #${pr.number}, so nothing was posted. The next round reviews it and carries these findings in.`,
      );
      return true;
    };

    /**
     * Jev's pass over the diff the tree holds: the reviewer's reading order, the places to look
     * first, and the diff cut to what each tier needs. Nothing of it reaches the PR. A failure
     * costs the map, not the round, and the whole diff goes.
     */
    const screen = async (): Promise<{ map: string; diff: string }> => {
      let found: Report | null;
      try {
        found = await jev.review({ dir, diff, about: `${pr.title}\n\n${description}` });
      } catch (error) {
        await view.show(`The Jev pass did not run: ${messageOf(error)}`);
        return { map: "", diff };
      }
      if (found === null) return { map: "", diff };
      await view.show(
        `Jev screened ${found.files} files: ${found.matrix.filter((one) => one.tier === "deep").length} to read closely`,
      );
      return { map: mapped(found, dir), diff: diffFor(found, diff) };
    };

    /** The claims the code at their own cited line does not carry. A failed check clears none of them. */
    const weak = async (claims: Claimed[]): Promise<Set<number>> => {
      if (dir === "" || claims.length === 0) return new Set();
      try {
        const checked = await jev.check({ dir, claims });
        return new Set(
          checked
            .map((one, index) =>
              one.read && one.confidence >= SETTLED && one.verdict !== "supported" ? index : -1,
            )
            .filter((index) => index !== -1),
        );
      } catch (error) {
        await view.show(`The evidence check did not run, so every claim stands: ${messageOf(error)}`);
        return new Set();
      }
    };

    /**
     * A blocker has to be carried by the code it cites. One that is not still reaches the author,
     * as a non-blocker saying so, because a claim the check cannot place is not a claim disproved.
     */
    /** A weak blocker stops blocking and says so. A weak non-blocker is noise, so it goes. */
    const vetted = async (findings: Findings): Promise<Findings> => {
      const failed = await weak([...findings.blockers, ...findings.nonBlockers]);
      if (failed.size === 0) return findings;
      const offset = findings.blockers.length;
      const blockers = findings.blockers.filter((_, index) => !failed.has(index));
      const demoted = findings.blockers
        .filter((_, index) => failed.has(index))
        .map((one) => ({ ...one, claim: `${one.claim}. The code at this line does not show this` }));
      const nonBlockers = findings.nonBlockers.filter((_, index) => !failed.has(offset + index));
      const dropped = findings.nonBlockers.filter((_, index) => failed.has(offset + index));
      if (demoted.length > 0) {
        await view.show(
          `${demoted.length} of ${findings.blockers.length} blockers are not carried by the code they cite, so they no longer block.`,
        );
      }
      if (dropped.length > 0) {
        await view.show(
          `${dropped.length} of ${findings.nonBlockers.length} non-blockers are not carried by the code they cite, so they are dropped:\n\n${claimed(dropped)}`,
        );
      }
      return { ...findings, blockers, nonBlockers: [...nonBlockers, ...demoted] };
    };

    // The watch may never report our own comment, so a post marks the overview sent here too.
    const overviewed = (): boolean =>
      introduced || notes.some((note) => note.body.includes(OVERVIEW_MARK));

    /** The comment as the author reads it: the overview on the first one only. */
    const drafted = (findings: Findings): string =>
      overviewed() ? verdict(findings) : report(findings);

    const post = async (findings: Findings): Promise<void> => {
      const body = overviewed() ? verdict(findings) : `${OVERVIEW_MARK}\n\n${report(findings)}`;
      await github.pr.comment(params.pr, { body });
      introduced = true;
      posted += 1;
    };

    /**
     * One turn run against the changes watch. A push, a close, an approval, a draft, or a queue
     * ends the round; anything else is context for the next one and the turn runs on.
     */
    const raced = async (prompt: string): Promise<Ran<Findings>> => {
      const turn = agent.turn(reviewer, { skill: "review-pr", prompt }, { result: Findings });
      const shown = narrate(view, turn.output);
      const stopTurn = async (): Promise<void> => {
        await agent.stop(reviewer);
        await turn.value.catch(() => {});
        await shown;
      };
      for (;;) {
        const first = await Promise.race([
          turn.value.then(
            () => "turn" as const,
            () => "turn" as const,
          ),
          inbound.then(() => "change" as const),
        ]);
        if (first === "turn") break;
        const change: Change = await inbound;
        inbound = changes.next();
        if (change.kind === "closed") {
          await stopTurn();
          await view.show(`PR #${pr.number} is ${change.state}, the review stops`);
          return { stop: "closed" };
        }
        if (change.kind === "approved") {
          await stopTurn();
          await view.show(`PR #${pr.number} is approved, this round has nothing left to say`);
          return { stop: "approved" };
        }
        if (change.kind === "draft") {
          await stopTurn();
          await view.show(`PR #${pr.number} went to draft, the review waits`);
          return { stop: "draft" };
        }
        if (change.kind === "queued") {
          await stopTurn();
          await view.show(`PR #${pr.number} is queued to merge, the review waits`);
          return { stop: "queued" };
        }
        // A stale round syncs before the watch reports, so a push the tree holds already is not news.
        if (change.kind === "commits" && (await since()) === "moved") {
          await stopTurn();
          await view.show(`New code was pushed to PR #${pr.number}, the round starts over on it`);
          return { stop: "stale" };
        }
        if (change.kind === "description") description = change.body;
        if (change.kind === "comments") notes = notes.concat(change.comments);
      }

      // A turn that will not finish pauses the run. The review takes it up again on the resume.
      try {
        return { value: await turn.value };
      } finally {
        await shown;
      }
    };

    const review = async (): Promise<"approved" | "sent" | Stop> => {
      await synced();
      const seen = await screen();
      const reviewed = await raced(opening(seen.map, seen.diff));
      if ("stop" in reviewed) return reviewed.stop;

      let findings = await vetted(reviewed.value);
      previous = findings;
      while (findings.blockers.length > 0) {
        const answer = await view.ask(
          `${drafted(findings)}\n\nPost this without approving?`,
          z.union([z.enum(["send"]), z.string()]),
        );
        if (answer === "send") {
          if (await overtaken()) return "stale";
          await post(findings);
          await view.show(`Posted feedback on PR #${pr.number} without approving`);
          return "sent";
        }
        const said = await raced(
          `The user says:\n\n${answer}\n\nAnswer it, read whatever code it turns on, adjust the findings where the user is right, and return the full updated findings.`,
        );
        if ("stop" in said) return said.stop;
        findings = await vetted(said.value);
        previous = findings;
      }
      if (await overtaken()) return "stale";
      await post(findings);
      try {
        await github.pr.approve(params.pr);
        await view.show(`Approved PR #${pr.number}`);
      } catch (error) {
        // Some approvals are refused outright, e.g. your own PR. The review still counts.
        await view.show(`The approve failed: ${messageOf(error)}`);
      }
      return "approved";
    };

    try {
      for (;;) {
        if (owed && !inDraft && !paused) {
          if (!(await hold())) break;
          rounds += 1;
          await view.show(`review round ${rounds}`);
          const outcome = await review();
          if (outcome === "closed") break;
          if (outcome === "draft") {
            inDraft = true;
            continue;
          }
          if (outcome === "queued") {
            paused = true;
            continue;
          }
          // A round the new code overtook owes a review still, on a reviewer that has not read the old code.
          if (outcome === "stale") {
            reviewer = await opened();
            continue;
          }
          owed = false;
          continue;
        }
        await drop();
        await view.status(`waiting for changes on PR #${pr.number}`, { idle: true });
        const change = await inbound;
        inbound = changes.next();
        if (change.kind === "closed") {
          await view.show(`PR #${pr.number} is ${change.state}`);
          break;
        }
        if (change.kind === "approved") {
          await view.show(`PR #${pr.number} is approved, the review waits for the merge`);
        }
        if (change.kind === "draft") inDraft = true;
        if (change.kind === "ready") inDraft = false;
        if (change.kind === "queued") {
          paused = true;
          await view.show(`PR #${pr.number} is queued to merge, the review waits`);
        }
        if (change.kind === "dequeued") {
          paused = false;
          await view.show(`PR #${pr.number} left the merge queue`);
        }
        if (change.kind === "commits") owed = true;
        if (change.kind === "description") description = change.body;
        if (change.kind === "comments") notes = notes.concat(change.comments);
      }
    } finally {
      await drop();
    }
    return { rounds, posted };
  },
});
