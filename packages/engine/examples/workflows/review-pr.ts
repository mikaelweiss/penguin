import { messageOf, workflow } from "penguin";
import { z } from "zod";
import { narrate, narrated, retried } from "../helpers/turns.ts";
import { openWorktree } from "../helpers/worktree.ts";

const DIFF_LINES = 500;

const Triage = z.object({
  eyeball: z
    .boolean()
    .describe("true when a person can read the whole change and judge it in a minute"),
  reason: z.string().describe("the one line that decides it"),
});

const Findings = z.object({
  blockers: z
    .array(z.string())
    .describe("the issues that must change before an approve"),
  nonBlockers: z
    .array(z.string())
    .describe("the improvements the author may take or leave"),
});

type Findings = z.infer<typeof Findings>;
type Note = { author: string; at: string; body: string };

function listed(items: string[]): string {
  return items.length === 0 ? "none" : items.map((item) => `- ${item}`).join("\n");
}

function report(findings: Findings): string {
  return `### Blockers\n\n${listed(findings.blockers)}\n\n### Non-blockers\n\n${listed(findings.nonBlockers)}`;
}

function cut(diff: string): string {
  const lines = diff.split("\n");
  if (lines.length <= DIFF_LINES) return diff;
  return `${lines.slice(0, DIFF_LINES).join("\n")}\n\n[cut here: the diff runs ${lines.length} lines]`;
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

export default workflow({
  description:
    "review an open pull request: triage it first, post the findings, approve when nothing blocks, and re-review every push until your approval lands or it closes",
  params: z.object({ pr: z.string().describe("the pull request, as a number or a url") }),

  async run(ctx) {
    const { params, agent, vcs, github, view } = ctx;
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
    const judge = await agent.open();
    const triaged = await narrated(view, () =>
      agent.turn(
        judge,
        { skill: "triage-pr", prompt: `${briefing()}\n\n# Diff\n\n${cut(diff)}` },
        { result: Triage },
      ),
    );
    if (triaged.eyeball) {
      const choice = await view.ask(
        `PR #${pr.number} is small enough to read yourself: ${triaged.reason}\n\n${pr.url}\n\nType review to run the full review, or mine to leave it to you.`,
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
    const name = `review-pr-${pr.number}`;
    const dir = await openWorktree(ctx, name, { ref });
    if (dir === "") return { rounds: 0, posted: 0 };

    const changes = github.pr.changes(params.pr);
    let inbound = changes.next();
    let previous: Findings | undefined;
    let inDraft = pr.isDraft;
    let paused = pr.isInMergeQueue;
    let owed = true;
    let rounds = 0;
    let posted = 0;
    let head = "";

    const opening = (): string =>
      previous === undefined
        ? `Review this pull request. The working tree holds its code.\n\n${briefing()}\n\n${changed(pr.baseRefName, diff)}`
        : `New code arrived since the last review, and the working tree holds it. The last review found:\n\n${report(previous)}\n\nCheck whether each finding still holds, review what changed, and return the full updated findings.\n\n${briefing()}\n\n${changed(pr.baseRefName, diff)}`;

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
      if (head === "") return "unread";
      // A freshness read stays best-effort: a fault here must not hold the review at a gate.
      try {
        await vcs.fetch(ref, { cwd: dir });
        const now = await vcs.sha("FETCH_HEAD", { cwd: dir });
        return now.sha === head ? "same" : "moved";
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

    const post = async (findings: Findings): Promise<void> => {
      await github.pr.comment(params.pr, { body: report(findings) });
      posted += 1;
    };

    const review = async (): Promise<
      "approved" | "sent" | "closed" | "draft" | "queued" | "stale"
    > => {
      await synced();
      const reviewer = await agent.open({ cwd: dir });
      let turn = agent.turn(reviewer, { skill: "review-pr", prompt: opening() }, { result: Findings });
      let shown = narrate(view, turn.output);
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
        const change = await inbound;
        inbound = changes.next();
        if (change.kind === "closed") {
          await stopTurn();
          await view.show(`PR #${pr.number} is ${change.state}, the review stops`);
          return "closed";
        }
        if (change.kind === "approved") {
          await stopTurn();
          await view.show(`You approved PR #${pr.number}, the review stops`);
          return "approved";
        }
        if (change.kind === "draft") {
          await stopTurn();
          await view.show(`PR #${pr.number} went to draft, the review waits`);
          return "draft";
        }
        if (change.kind === "queued") {
          await stopTurn();
          await view.show(`PR #${pr.number} is queued to merge, the review waits`);
          return "queued";
        }
        if (change.kind === "ready") continue;
        if (change.kind === "dequeued") continue;
        if (change.kind === "reviewed") continue;
        // A stale round syncs before the watch reports, so a push the tree holds already is not news.
        if (change.kind === "commits" && (await since()) !== "moved") continue;
        await stopTurn();
        let update: string;
        if (change.kind === "commits") {
          await synced();
          update = `New code was pushed to the PR. The working tree now holds it. Continue the review over the current code.\n\n${changed(pr.baseRefName, diff)}`;
        } else if (change.kind === "description") {
          description = change.body;
          update = `The PR description changed. The new description:\n\n${change.body}\n\nTake it as added context and continue the review.`;
        } else {
          notes = notes.concat(change.comments);
          update = `New comments arrived on the PR:\n\n${noted(change.comments)}\n\nTake them as added context and continue the review.`;
        }
        turn = agent.turn(reviewer, { skill: "review-pr", prompt: update }, { result: Findings });
        shown = narrate(view, turn.output);
      }

      // A turn that will not finish is the person's to clear. The review does not end on it.
      let findings: z.infer<typeof Findings>;
      for (;;) {
        try {
          findings = await turn.value;
          await shown;
          break;
        } catch (error) {
          await shown;
          await retried(view, error);
          turn = agent.turn(reviewer, { skill: "review-pr", prompt: opening() }, { result: Findings });
          shown = narrate(view, turn.output);
        }
      }
      previous = findings;
      while (findings.blockers.length > 0) {
        const answer = await view.ask(
          `${report(findings)}\n\nPost this without approving?`,
          z.union([z.enum(["send"]), z.string()]),
        );
        if (answer === "send") {
          if (await overtaken()) return "stale";
          await post(findings);
          await view.show(`Posted feedback on PR #${pr.number} without approving`);
          return "sent";
        }
        findings = await narrated(view, () =>
          agent.turn(
            reviewer,
            {
              skill: "review-pr",
              prompt: `The user says:\n\n${answer}\n\nAnswer it, adjust the findings where the user is right, and return the full updated findings.`,
            },
            { result: Findings },
          ),
        );
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
          rounds += 1;
          await view.show(`review round ${rounds}`);
          const outcome = await review();
          if (outcome === "closed" || outcome === "approved") break;
          if (outcome === "draft") {
            inDraft = true;
            continue;
          }
          if (outcome === "queued") {
            paused = true;
            continue;
          }
          // A round the new code overtook owes a review still, so the loop goes straight round again.
          if (outcome === "stale") continue;
          owed = false;
          continue;
        }
        await view.status(`waiting for changes on PR #${pr.number}`, { idle: true });
        const change = await inbound;
        inbound = changes.next();
        if (change.kind === "closed") {
          await view.show(`PR #${pr.number} is ${change.state}`);
          break;
        }
        if (change.kind === "approved") {
          await view.show(`You approved PR #${pr.number}, the review stops`);
          break;
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
      try {
        await vcs.worktree.remove(dir);
      } catch (error) {
        await view.show(`the worktree stayed: ${messageOf(error)}`);
      }
    }
    return { rounds, posted };
  },
});
