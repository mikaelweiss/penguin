import { workflow } from "penguin";
import { z } from "zod";

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
  return items.length === 0
    ? "none"
    : items.map((item) => `- ${item}`).join("\n");
}

function report(findings: Findings): string {
  return `### Blockers\n\n${listed(findings.blockers)}\n\n### Non-blockers\n\n${listed(findings.nonBlockers)}`;
}

function noted(notes: Note[]): string {
  return notes
    .map((note) => `## ${note.author} on ${note.at}\n\n${note.body}`)
    .join("\n\n");
}

export default workflow({
  description:
    "review an open pull request: post the findings, approve when nothing blocks, and re-review every push until it closes",
  params: z.object({ pr: z.string() }),

  async run({ params, agent, vcs, github, view, gate }) {
    const found = await github.pr.get(params.pr);
    if (!found.ok || found.pr === null) {
      await gate(`gh pr view ${params.pr} failed: ${found.reason}`);
      return { rounds: 0, posted: 0 };
    }
    const pr = found.pr;
    if (pr.state !== "OPEN") {
      view.event({
        message: `PR #${pr.number} is ${pr.state}, nothing to review`,
      });
      return { rounds: 0, posted: 0 };
    }

    const said = await github.pr.comments(params.pr);
    if (!said.ok)
      view.event({
        level: "warn",
        message: `The PR comments did not read: ${said.reason}`,
      });
    let description = pr.body;
    let notes: Note[] = said.comments;

    const ref = `pull/${pr.number}/head`;
    const name = `review-pr-${pr.number}`;
    let ws = await vcs.worktree.add(name, { ref });
    while (!ws.ok) {
      if (!ws.exists) {
        await gate(`The worktree failed: ${ws.reason}`);
        return { rounds: 0, posted: 0 };
      }
      const choice = await gate(
        `A worktree already sits at ${ws.path}. Type use to review in it, replace to delete it and cut a fresh one, or exit to stop.`,
        z.enum(["use", "replace", "exit"]),
      );
      if (choice === "exit") return { rounds: 0, posted: 0 };
      if (choice === "use") break;
      const gone = await vcs.worktree.remove(ws.path, { force: true });
      if (!gone.ok) {
        view.event({
          level: "warn",
          message: `The worktree did not delete: ${gone.reason}`,
        });
        continue;
      }
      ws = await vcs.worktree.add(name, { ref });
    }
    view.artifact({ title: `PR #${pr.number}: ${pr.title}`, url: pr.url });
    view.watch({ elapsed: true });

    const changes = await github.pr.changes(params.pr);
    let inbound = changes.next();
    let previous: Findings | undefined;
    let inDraft = pr.isDraft;
    let owed = true;
    let rounds = 0;
    let posted = 0;

    const briefing = (): string => {
      const conversation =
        notes.length === 0 ? "" : `\n\n# Comments\n\n${noted(notes)}`;
      return `# PR #${pr.number}: ${pr.title}\n\n${pr.url}\n\n${description}${conversation}`;
    };

    const opening = (): string =>
      previous === undefined
        ? `Review this pull request. The working tree holds its code.\n\n${briefing()}`
        : `New code arrived since the last review, and the working tree holds it. The last review found:\n\n${report(previous)}\n\nCheck whether each finding still holds, review what changed, and return the full updated findings.\n\n${briefing()}`;

    const pulled = async (): Promise<void> => {
      const done = await vcs.pull(ref, { cwd: ws.path });
      if (!done.ok)
        await gate(
          `The pull failed: ${done.reason} Reply to go on with the last fetched code.`,
        );
    };

    const post = async (findings: Findings): Promise<void> => {
      const sent = await github.pr.comment(params.pr, {
        body: report(findings),
      });
      if (!sent.ok) {
        await gate(`The comment failed: ${sent.reason}`);
        return;
      }
      posted += 1;
    };

    const review = async (): Promise<
      "approved" | "sent" | "closed" | "draft"
    > => {
      await pulled();
      const reviewer = agent({ cwd: ws.path, name: `reviewer-${rounds}` });
      let turn = reviewer.run("penguin-review-pr", {
        input: opening(),
        result: Findings,
      });
      for (;;) {
        const first = await Promise.race([
          turn.then(() => "turn" as const),
          inbound.then(() => "change" as const),
        ]);
        if (first === "turn") break;
        const change = await inbound;
        inbound = changes.next();
        if (change.kind === "closed") {
          await turn.stop();
          view.event({
            message: `PR #${pr.number} is ${change.state}, the review stops`,
          });
          return "closed";
        }
        if (change.kind === "draft") {
          await turn.stop();
          view.event({
            message: `PR #${pr.number} went to draft, the review waits`,
          });
          return "draft";
        }
        if (change.kind === "ready") continue;
        await turn.stop();
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
        turn = reviewer.run("penguin-review-pr", {
          input: update,
          result: Findings,
        });
      }

      let findings = (await turn)!;
      previous = findings;
      while (findings.blockers.length > 0) {
        const answer = await gate(
          `${report(findings)}\n\nType send to post this without approving, or type feedback for the reviewer.`,
        );
        if (answer === "send") {
          await post(findings);
          view.event({
            message: `Posted feedback on PR #${pr.number} without approving`,
          });
          return "sent";
        }
        findings = (await reviewer.run("penguin-review-pr", {
          input: `The user says:\n\n${answer}\n\nAnswer it, adjust the findings where the user is right, and return the full updated findings.`,
          result: Findings,
        }))!;
        previous = findings;
      }
      await post(findings);
      const approved = await github.pr.approve(params.pr);
      if (!approved.ok) await gate(`The approve failed: ${approved.reason}`);
      else view.event({ message: `Approved PR #${pr.number}` });
      return "approved";
    };

    try {
      for (;;) {
        if (owed && !inDraft) {
          rounds += 1;
          view.fact({ phase: "reviewing", round: rounds });
          const outcome = await view.activity(`review round ${rounds}`, review);
          if (outcome === "closed") break;
          if (outcome === "draft") {
            inDraft = true;
            continue;
          }
          owed = false;
          continue;
        }
        view.fact({ phase: inDraft ? "draft" : "watching", round: rounds });
        const change = await inbound;
        inbound = changes.next();
        if (change.kind === "closed") {
          view.event({ message: `PR #${pr.number} is ${change.state}` });
          break;
        }
        if (change.kind === "draft") inDraft = true;
        if (change.kind === "ready") inDraft = false;
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
