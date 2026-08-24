import { workflow } from "penguin";
import { z } from "zod";
import { narrate, narrated } from "../helpers/turns.ts";

const Ack = z.union([z.enum(["ok"]), z.string()]);

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

export default workflow({
  description:
    "review an open pull request: triage it first, post the findings, approve when nothing blocks, and re-review every push until your approval lands or it closes",
  params: z.object({ pr: z.string().describe("the pull request, as a number or a url") }),

  async run({ params, agent, vcs, github, view }) {
    const found = await github.pr.get(params.pr);
    if (!found.ok || found.pr === null) {
      await view.ask(`gh pr view ${params.pr} failed: ${found.reason}`, Ack);
      return { rounds: 0, posted: 0 };
    }
    const pr = found.pr;
    if (pr.state !== "OPEN") {
      await view.show(`PR #${pr.number} is ${pr.state}, nothing to review`);
      return { rounds: 0, posted: 0 };
    }

    const said = await github.pr.comments(params.pr);
    if (!said.ok) await view.show(`The PR comments did not read: ${said.reason}`);
    let description = pr.body;
    let notes: Note[] = said.comments;

    const briefing = (): string => {
      const conversation = notes.length === 0 ? "" : `\n\n# Comments\n\n${noted(notes)}`;
      return `# PR #${pr.number}: ${pr.title}\n\n${pr.url}\n\n${description}${conversation}`;
    };

    // The triage reads the diff over the wire, so a PR the user takes costs no worktree.
    const looked = await github.pr.diff(params.pr);
    if (!looked.ok) await view.show(`The PR diff did not read: ${looked.reason}`);
    const judge = await agent.open();
    const triaged = await narrated(
      view,
      agent.turn(
        judge,
        { skill: "triage-pr", prompt: `${briefing()}\n\n# Diff\n\n${cut(looked.diff)}` },
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
    }

    const ref = `pull/${pr.number}/head`;
    const name = `review-pr-${pr.number}`;
    let ws = await vcs.worktree.add(name, { ref });
    while (!ws.ok) {
      if (!ws.exists) {
        await view.ask(`The worktree failed: ${ws.reason}`, Ack);
        return { rounds: 0, posted: 0 };
      }
      const choice = await view.ask(
        `A worktree already sits at ${ws.path}. Type use to review in it, replace to delete it and cut a fresh one, or exit to stop.`,
        z.enum(["use", "replace", "exit"]),
      );
      if (choice === "exit") return { rounds: 0, posted: 0 };
      if (choice === "use") break;
      const gone = await vcs.worktree.remove(ws.path, { force: true });
      if (!gone.ok) {
        await view.show(`The worktree did not delete: ${gone.reason}`);
        continue;
      }
      ws = await vcs.worktree.add(name, { ref });
    }

    const changes = github.pr.changes(params.pr);
    let inbound = changes.next();
    let previous: Findings | undefined;
    let inDraft = pr.isDraft;
    let paused = pr.isInMergeQueue;
    let owed = true;
    let rounds = 0;
    let posted = 0;

    const opening = (): string =>
      previous === undefined
        ? `Review this pull request. The working tree holds its code.\n\n${briefing()}`
        : `New code arrived since the last review, and the working tree holds it. The last review found:\n\n${report(previous)}\n\nCheck whether each finding still holds, review what changed, and return the full updated findings.\n\n${briefing()}`;

    const pulled = async (): Promise<void> => {
      const done = await vcs.pull(ref, { cwd: ws.path });
      if (!done.ok)
        await view.ask(
          `The pull failed: ${done.reason} The review goes on with the last fetched code.`,
          Ack,
        );
    };

    const post = async (findings: Findings): Promise<void> => {
      const sent = await github.pr.comment(params.pr, { body: report(findings) });
      if (!sent.ok) {
        await view.ask(`The comment failed: ${sent.reason}`, Ack);
        return;
      }
      posted += 1;
    };

    const review = async (): Promise<"approved" | "sent" | "closed" | "draft" | "queued"> => {
      await pulled();
      const reviewer = await agent.open({ cwd: ws.path });
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
        await stopTurn();
        let update: string;
        if (change.kind === "commits") {
          await pulled();
          update =
            "New code was pushed to the PR. The working tree now holds it. Continue the review over the current code.";
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

      let findings = await turn.value;
      await shown;
      previous = findings;
      while (findings.blockers.length > 0) {
        const answer = await view.ask(
          `${report(findings)}\n\nPost this without approving?`,
          z.union([z.enum(["send"]), z.string()]),
        );
        if (answer === "send") {
          await post(findings);
          await view.show(`Posted feedback on PR #${pr.number} without approving`);
          return "sent";
        }
        findings = await narrated(
          view,
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
      await post(findings);
      const approved = await github.pr.approve(params.pr);
      if (!approved.ok) await view.ask(`The approve failed: ${approved.reason}`, Ack);
      else await view.show(`Approved PR #${pr.number}`);
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
          owed = false;
          continue;
        }
        await view.show(`waiting for changes on PR #${pr.number}`, { kind: "waiting" });
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
      await vcs.worktree.remove(ws.path);
    }
    return { rounds, posted };
  },
});
