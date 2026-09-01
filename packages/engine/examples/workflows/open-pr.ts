import { call, isWithdrawn, workflow } from "penguin";
import { z } from "zod";
import { resolveBase } from "../helpers/base.ts";
import { narrated } from "../helpers/turns.ts";
import commit from "./commit.ts";
import rebase from "./rebase.ts";

const Confirm = z.enum(["ok", "stop"]);
const Go = z.union([z.enum(["go", "skip"]), z.string()]);

const Triage = z.object({
  asks: z.boolean().describe("true when the author has to change or answer something"),
  why: z.string().describe("one line naming the fact that decided it"),
});

/** One thing that arrived. The user's own words go straight to a round; everything else is triaged first. */
type Arrival = { author: string; text: string; fromUser: boolean };

const Description = z.object({
  title: z.string().describe("the pull request title, one line"),
  body: z.string().describe("the pull request body, markdown, empty when the title says it all"),
});

const Assessment = z.object({
  issues: z
    .array(
      z.object({
        title: z.string().describe("the issue in one short line, in plain words"),
        where: z.string().describe("the file and lines it lands on, empty when it names no code"),
        holds: z.boolean().describe("true when the code confirms the issue"),
        why: z.string().describe("one or two plain sentences on what the code actually does"),
        action: z
          .enum(["change", "reply"])
          .describe("change the code, or reply to the thread and leave the code alone"),
        plan: z
          .string()
          .describe("exactly what changes, file by file, or exactly what the reply says"),
      }),
    )
    .describe("one entry per issue, empty when nothing is left open"),
});

type Assessment = z.infer<typeof Assessment>;

const REVIEWS: Record<string, string> = {
  APPROVED: "approved it",
  CHANGES_REQUESTED: "asked for changes",
  COMMENTED: "left comments",
  DISMISSED: "had a review dismissed",
};

function worded(state: string): string {
  return REVIEWS[state] ?? `left a ${state.toLowerCase().replace(/_/g, " ")} review`;
}

/** The assessment as the person reads it, so the gate shows the same thing the agent will do. */
function proposal(assessment: Assessment): string {
  return assessment.issues
    .map((issue, index) => {
      const place = issue.where === "" ? "" : `\n\n${issue.where}`;
      const verdict = issue.holds ? "This holds." : "This does not hold.";
      const doing = issue.action === "change" ? "Change" : "Reply";
      return `### ${index + 1}. ${issue.title}${place}\n\n${verdict} ${issue.why}\n\n**${doing}:** ${issue.plan}`;
    })
    .join("\n\n");
}

export default workflow({
  description:
    "open the pull request, then watch it: assess every piece of feedback against the code, and answer what you approve until it merges",
  params: z.object({
    base: z
      .string()
      .default("main")
      .describe("the branch the pull request lands on, empty to take the one origin calls default"),
    note: z
      .string()
      .default("")
      .describe(
        "markdown appended to the pull request body, e.g. what a calling workflow carried past",
      ),
    ticket: z
      .string()
      .default("")
      .describe("the issue id the title and every commit carry verbatim, empty when there is none"),
  }),

  async run(ctx) {
    const { agent, github, params, vcs, view } = ctx;
    const nowhere = { url: "", state: "", rounds: 0 };

    const head = await vcs.head();
    if (head.detached) {
      await view.show(
        "The checkout is detached, so there is no branch to push. Check out a branch, then run open-pr again.",
      );
      return nowhere;
    }

    let base = await resolveBase(ctx, params.base);
    if (base === "") return nowhere;
    if (head.branch === base) {
      const answer = await view.ask(
        `The checkout is on ${base}, the branch the pull request would land on. Reply ok to open it from ${base} onto itself anyway, or stop.`,
        Confirm,
      );
      if (answer === "stop") return nowhere;
    }

    /**
     * The one way anything reaches origin: commit what the tree holds, then
     * converge the branch onto its base and onto origin. Conflicts go to the
     * rebase workflow, whose agent resolves them in the open tree. False means
     * the person dropped the rebase, which ends the run.
     */
    const delivered = async (): Promise<boolean> => {
      await call(ctx, commit, { ticket: params.ticket });
      for (;;) {
        const synced = await vcs.sync(head.branch, base);
        if (!synced.conflicted) return true;
        const landed = await call(ctx, rebase, { base });
        if (!landed.rebased) return false;
      }
    };

    if (!(await delivered())) return nowhere;

    const writer = await agent.open();
    const written = await narrated(view, () =>
      agent.turn(
        writer,
        {
          skill: "open-pr",
          prompt:
            params.ticket === ""
              ? `# Base branch\n\n${base}`
              : `# Base branch\n\n${base}\n\n# Ticket\n\n${params.ticket}`,
        },
        { result: Description },
      ),
    );
    // The note is the caller's, so it goes under a body the agent wrote knowing nothing of it.
    const body = params.note === "" ? written.body : `${written.body}\n\n${params.note}`;

    const made = await github.pr.ensure({ head: head.branch, base, title: written.title, body });
    if (made.landed) {
      await view.show(
        made.pr === null
          ? `${head.branch} has nothing over ${base}, so its work already landed`
          : `PR #${made.pr.number} already merged`,
      );
      return { url: made.pr?.url ?? "", state: made.pr?.state ?? "MERGED", rounds: 0 };
    }
    const pr = made.pr;
    if (pr === null) return nowhere;
    if (pr.baseRefName !== base) {
      // A branch with an open pull request lands where that pull request says. Rebasing it
      // anywhere else force-pushes a stacked branch out from under the one it was opened on.
      const answer = await view.ask(
        `PR #${pr.number} is open from ${head.branch} onto ${pr.baseRefName}, not ${base}. Reply ok to land it on ${pr.baseRefName}, or stop.`,
        Confirm,
      );
      if (answer === "stop") return nowhere;
      base = pr.baseRefName;
    }
    await view.show(`PR is up: ${pr.url}`);

    // ---- the watch ----
    // Pumps keep what arrived; the loop reads the pull request fresh before it
    // acts, so nothing decides on a snapshot older than the block it just left.
    let feedback: Arrival[] = made.created
      ? []
      : [
          {
            author: "",
            text: "The pull request was already open before this run. Take whatever its threads still leave open.",
            fromUser: true,
          },
        ];
    let baseMoved = false;
    let ended = "";
    let rounds = 0;

    let wake: (() => void) | undefined;
    let pending = false;
    const poke = (): void => {
      pending = true;
      wake?.();
    };
    const wait = async (): Promise<void> => {
      if (pending) {
        pending = false;
        return;
      }
      await new Promise<void>((settle) => {
        wake = settle;
      });
      wake = undefined;
      pending = false;
    };

    // What every open gate races against: a closed pull request withdraws its questions.
    let closeNow: (reason: string) => void = () => {};
    const closed = new Promise<string>((settle) => {
      closeNow = settle;
    });

    const changes = github.pr.changes(String(pr.number));
    void (async () => {
      for (;;) {
        const change = await changes.next();
        if (change.kind === "closed") {
          ended = change.state;
          closeNow(`PR #${pr.number} is ${change.state}, so the question is moot`);
          poke();
          return;
        }
        if (change.kind === "reviewed") {
          // A bare approval is news. Every other review can carry inline threads the assessment reads.
          if (change.state === "APPROVED" && change.body === "") {
            await view.show(`${change.author} approved PR #${pr.number}`);
          } else {
            const said = change.body === "" ? "" : `:\n\n${change.body}`;
            feedback.push({
              author: change.author,
              text: `${change.author} ${worded(change.state)}${said}`,
              fromUser: false,
            });
          }
        }
        if (change.kind === "comments") {
          feedback.push(
            ...change.comments.map((note) => ({
              author: note.author,
              text: `${note.author} commented:\n\n${note.body}`,
              fromUser: false,
            })),
          );
        }
        if (change.kind === "draft") await view.show(`PR #${pr.number} went to draft, the watch holds`);
        if (change.kind === "ready") await view.show(`PR #${pr.number} is ready for review again`);
        if (change.kind === "queued") {
          await view.show(`PR #${pr.number} is queued to merge, the watch holds`);
        }
        if (change.kind === "dequeued") await view.show(`PR #${pr.number} left the merge queue`);
        poke();
      }
    })();

    const based = head.branch === base ? undefined : github.branch.moved(base);
    if (based !== undefined) {
      void (async () => {
        for (;;) {
          await based.next();
          baseMoved = true;
          poke();
        }
      })();
    }

    const typed = view.listen()[Symbol.asyncIterator]();
    void (async () => {
      for (;;) {
        const message = await typed.next();
        if (message.done === true) return;
        feedback.push({ author: "", text: `The user says:\n\n${message.value.text}`, fromUser: true });
        poke();
      }
    })();

    let session = "";
    const opened = async (): Promise<string> => {
      if (session === "") session = await agent.open();
      return session;
    };

    // The judge reads text and nothing else, so its session carries no tools and no setup.
    let judge = "";
    const asks = async (arrival: Arrival): Promise<boolean> => {
      if (arrival.fromUser) return true;
      if (judge === "") {
        judge = await agent.open({ model: "small", tools: [], settings: [], effort: "low" });
      }
      const verdict = await narrated(view, () =>
        agent.turn(judge, { skill: "triage-feedback", prompt: arrival.text }, { result: Triage }),
      );
      if (!verdict.asks) await view.show(`${arrival.author} asks nothing: ${verdict.why}`);
      return verdict.asks;
    };

    const assessed = async (who: string, prompt: string): Promise<Assessment> =>
      narrated(view, () =>
        agent.turn(who, { skill: "assess-feedback", prompt }, { result: Assessment }),
      );

    const applied = async (who: string, heading: string, what: string): Promise<void> => {
      await narrated(view, () =>
        agent.turn(who, {
          skill: "address-feedback",
          prompt: `# Pull request\n\n${pr.url}\n\n# ${heading}\n\n${what}`,
        }),
      );
    };

    /** The branch back onto a base that moved under it. Nothing here ends the watch. */
    const followed = async (): Promise<void> => {
      let synced = await vcs.sync(head.branch, base);
      if (synced.conflicted) {
        const landed = await call(ctx, rebase, { base });
        if (!landed.rebased) {
          await view.show(`The rebase onto the new ${base} was dropped, so the branch stays put`);
          return;
        }
        synced = await vcs.sync(head.branch, base);
        if (synced.conflicted) {
          await view.show(`${base} conflicts again already, so the branch stays put`);
          return;
        }
      }
      await view.show(
        synced.same
          ? `${head.branch} has nothing over ${base}, so nothing goes up`
          : `${head.branch} is up on the new ${base}`,
      );
    };

    /** One round: assess, gate the plan, apply it, commit, gate the push. */
    const round = async (asks: string[]): Promise<void> => {
      const who = await opened();
      let plan = await assessed(
        who,
        `# Pull request\n\n${pr.url}\n\n# What arrived\n\n${asks.join("\n\n")}`,
      );

      for (;;) {
        if (plan.issues.length === 0) {
          await view.show(`Nothing on PR #${pr.number} is left to answer`);
          return;
        }
        const answer = await view.ask(
          `${proposal(plan)}\n\nReply go to do this, skip to leave it, or say what to change about the plan.`,
          Go,
          { until: closed },
        );
        if (isWithdrawn(answer)) {
          await view.show(answer.reason);
          return;
        }
        if (answer === "skip") {
          await view.show(`Round ${rounds} stays unanswered`);
          return;
        }
        if (answer === "go") break;
        plan = await assessed(
          who,
          `The user says:\n\n${answer}\n\nAnswer it, adjust the assessment where the user is right, and return the whole thing again.`,
        );
      }

      await applied(who, "The approved plan", proposal(plan));

      // The person approved the plan, so what it wrote goes up without a second gate.
      const wrote = await call(ctx, commit, { ticket: params.ticket });
      if (!wrote.committed) {
        await view.show("No code changed, so nothing goes up");
        return;
      }
      if (!(await delivered())) {
        await view.show("The rebase was dropped, so the commit stays local");
        return;
      }
      await view.show(`Pushed to PR #${pr.number}: ${wrote.message.split("\n")[0] ?? ""}`);
    };

    let state = pr.state;
    try {
      for (;;) {
        if (ended !== "") {
          state = ended;
          await view.show(`PR #${pr.number} is ${state}`);
          break;
        }

        if (baseMoved || feedback.length > 0) {
          // The move or the feedback is news about a world that kept moving while
          // it queued, so the pull request is read again before anything acts.
          const now = await github.pr.get(pr.url);
          if (now === null) {
            await view.show(`PR #${pr.number} did not read, so the watch holds`);
          } else if (now.state !== "OPEN") {
            state = now.state;
            await view.show(`PR #${pr.number} is ${state}`);
            break;
          } else if (now.isInMergeQueue) {
            // The queue merges or kicks back, and either way the watch hears it.
            await view.status(`PR #${pr.number} is queued to merge, the watch holds`, { idle: true });
          } else if (baseMoved) {
            baseMoved = false;
            await followed();
            continue;
          } else if (!now.isDraft) {
            const arrived = feedback;
            feedback = [];
            const open: string[] = [];
            for (const one of arrived) if (await asks(one)) open.push(one.text);
            if (open.length === 0) continue;
            rounds += 1;
            await view.show(`feedback round ${rounds}`);
            await round(open);
            continue;
          }
        }

        await view.status(`watching PR #${pr.number}`, { idle: true });
        await wait();
      }
    } finally {
      await typed.return?.(undefined);
    }

    return { url: pr.url, state, rounds };
  },
});
