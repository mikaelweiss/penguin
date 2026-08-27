import { call, workflow } from "penguin";
import { z } from "zod";
import { resolveBase } from "../helpers/base.ts";
import { narrated } from "../helpers/turns.ts";
import commit from "./commit.ts";
import rebase from "./rebase.ts";

const Ack = z.enum(["ok"]);
const Confirm = z.enum(["ok", "stop"]);
const Retry = z.enum(["retry", "stop"]);
const Fixing = z.union([z.enum(["retry", "stop"]), z.string()]);
const Go = z.union([z.enum(["go", "skip"]), z.string()]);
const Send = z.union([z.enum(["push", "hold"]), z.string()]);

const Description = z.object({
  title: z.string().describe("the pull request title, one line"),
  body: z.string().describe("the pull request body, markdown, empty when the title says it all"),
});

const Fix = z.object({
  fixed: z.boolean().describe("true when the cause is cleared and the push is worth another try"),
  changed: z
    .boolean()
    .describe("true when the fix touched files that belong in a commit before the push"),
  notes: z
    .string()
    .describe("what stopped the push, and what a person has to do when it is not fixed"),
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

type Woke = { kind: "change" } | { kind: "said" } | { kind: "moved"; sha: string };

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
    fixes: z.number().int().min(1).default(3).meta({ internal: true }),
  }),

  async run(ctx) {
    const { agent, github, params, vcs, view } = ctx;
    const nowhere = { url: "", state: "", rounds: 0 };

    const head = await vcs.head();
    if (!head.ok) {
      await view.ask(`The checkout did not read: ${head.reason}`, Ack);
      return nowhere;
    }
    if (head.detached) {
      await view.ask(
        "The checkout is detached, so there is no branch to push. Check out a branch, then run open-pr again.",
        Ack,
      );
      return nowhere;
    }

    // What blocks a send is often a person's to fix, so the ask retries instead of ending the run.
    async function again(reason: string): Promise<boolean> {
      const answer = await view.ask(`${reason}\n\nFix it and reply retry, or stop.`, Retry);
      return answer === "retry";
    }

    let base = await resolveBase(ctx, params.base);
    if (base === "") return nowhere;
    // A branch that already has a pull request lands where that pull request says. Rebasing it
    // anywhere else force-pushes a stacked branch out from under the one it was opened on.
    for (;;) {
      const open = await github.pr.of(head.branch);
      if (!open.ok) {
        if (!(await again(`The pull requests on ${head.branch} did not read: ${open.reason}`))) {
          return nowhere;
        }
        continue;
      }
      const other = open.prs[0];
      if (other === undefined || open.prs.some((one) => one.baseRefName === base)) break;
      const answer = await view.ask(
        `PR #${other.number} is open from ${head.branch} onto ${other.baseRefName}, not ${base}. Reply ok to land it on ${other.baseRefName}, or stop.`,
        Confirm,
      );
      if (answer === "stop") return nowhere;
      base = other.baseRefName;
      break;
    }
    if (head.branch === base) {
      const answer = await view.ask(
        `The checkout is on ${base}, the branch the pull request would land on. Reply ok to open it from ${base} onto itself anyway, or stop.`,
        Confirm,
      );
      if (answer === "stop") return nowhere;
    }
    // A branch that is its own base has nothing to sit on, and force-pushing it would be a footgun.
    const rebasing = head.branch !== base;

    // The baseline poll fires here, not at the watch: a whole agent turn plus pr.create sits
    // between the first push and the watch, and a move in that window would go unseen.
    let ahead = "";
    const based = rebasing ? github.branch.moved(base) : undefined;
    let moving = based?.next();

    let fixer = "";

    async function fixing(prompt: string): Promise<{ retry: boolean; reason: string }> {
      if (fixer === "") fixer = await agent.open();
      const fix = await narrated(view, () =>
        agent.turn(fixer, { skill: "fix-push", prompt }, { result: Fix }),
      );
      if (!fix.fixed) return { retry: false, reason: fix.notes };
      // A fix left in the tree pushes nothing, so the same hook fails on the same code again.
      if (fix.changed) {
        const wrote = await call(ctx, commit, {});
        if (!wrote.ok) {
          return { retry: false, reason: `${fix.notes}\n\nThe fix did not commit: ${wrote.reason}` };
        }
      }
      return { retry: true, reason: fix.notes };
    }

    /**
     * A failed push goes to the agent before the person, because most of what stops one is the
     * agent's to clear. The bound keeps a fix it only thinks it made from spinning unattended.
     */
    async function cleared(
      reason: string,
      tries: number,
    ): Promise<{ retry: boolean; reason: string }> {
      if (tries > params.fixes) return { retry: false, reason };
      return fixing(`The push of ${head.branch} failed. git said:\n\n${reason}`);
    }

    /**
     * The push gate. The fixer just stopped here, so what the person types is its next
     * instruction, and no bound applies to a turn a person asked for by hand.
     */
    async function directed(reason: string): Promise<boolean> {
      let said = reason;
      for (;;) {
        const answer = await view.ask(
          `The branch did not reach the remote: ${said}\n\nFix it and reply retry, or stop.`,
          Fixing,
        );
        if (answer === "stop") return false;
        if (answer === "retry") return true;
        const fix = await fixing(`The user says:\n\n${answer}\n\nAnswer it and act on it.`);
        if (fix.retry) return true;
        said = fix.reason;
      }
    }

    /**
     * Parallel worktrees share one .git, so two setting an upstream at once race on its config
     * lock. That clears itself, and a whole agent turn is a waste of a wait.
     */
    async function sending(force: boolean): Promise<{ ok: boolean; reason: string }> {
      const first = await vcs.push(head.branch, { force });
      if (first.ok || !first.reason.includes("config.lock")) return first;
      await new Promise((settle) => setTimeout(settle, 1000));
      return vcs.push(head.branch, { force });
    }

    /**
     * The one way anything reaches origin. The branch sits on its base first, so no pull request
     * opens off a stale one, and the lease rides along because a rebased branch no longer
     * fast-forwards. A rebase that does not come back clean is a person's call, not a push.
     */
    async function pushed(): Promise<boolean> {
      let tries = 0;
      for (;;) {
        if (rebasing) {
          const landed = await call(ctx, rebase, { base });
          if (!landed.rebased) {
            if (!(await again(`The rebase onto ${base} failed: ${landed.reason}`))) return false;
            continue;
          }
        }
        const sent = await sending(rebasing);
        if (sent.ok) return true;
        tries += 1;
        const answer = await cleared(sent.reason, tries);
        if (answer.retry) continue;
        if (!(await directed(answer.reason))) return false;
      }
    }

    /**
     * The branch back onto a base that moved under it. A base that moved once will move again, so
     * every way this ends leaves the watch open, unlike pushed(), which ends the run on stop.
     */
    async function followed(): Promise<void> {
      const landed = await call(ctx, rebase, { base });
      if (!landed.rebased) {
        await view.show(`The rebase onto the new ${base} failed: ${landed.reason}`);
        return;
      }
      // Same abbreviation on both, so equal shas mean the branch has no commits of its own left.
      if (landed.sha === landed.base) {
        await view.show(`${head.branch} has nothing over ${base}, so nothing goes up`);
        return;
      }
      const sent = await sending(true);
      if (!sent.ok) {
        await view.show(`${head.branch} did not reach the remote: ${sent.reason}`);
        return;
      }
      await view.show(`${head.branch} is up on the new ${base}`);
    }

    // The pull request reads the remote, so every local change goes up before it is asked for.
    async function delivered(): Promise<boolean> {
      for (;;) {
        const wrote = await call(ctx, commit, {});
        if (wrote.ok) break;
        if (!(await again(`The commit failed: ${wrote.reason}`))) return false;
      }
      return pushed();
    }

    if (!(await delivered())) return nowhere;

    const writer = await agent.open();
    const written = await narrated(view, () =>
      agent.turn(
        writer,
        { skill: "open-pr", prompt: `# Base branch\n\n${base}` },
        { result: Description },
      ),
    );
    // The note is the caller's, so it goes under a body the agent wrote knowing nothing of it.
    const body = params.note === "" ? written.body : `${written.body}\n\n${params.note}`;
    let made = await github.pr.create({ title: written.title, body, base });
    while (!made.ok) {
      if (!(await again(`No pull request: ${made.reason}`))) return nowhere;
      made = await github.pr.create({ title: written.title, body, base });
    }

    const found = await github.pr.get(made.url);
    if (!found.ok || found.pr === null) {
      await view.ask(`The pull request did not read: ${found.reason}`, Ack);
      return { url: made.url, state: "", rounds: 0 };
    }
    const pr = found.pr;
    if (pr.state !== "OPEN") {
      await view.show(`PR #${pr.number} is ${pr.state}, nothing to watch`);
      return { url: pr.url, state: pr.state, rounds: 0 };
    }
    await view.show(`PR is up: ${pr.url}`);

    const changes = github.pr.changes(String(pr.number));
    let inbound = changes.next();
    const typed = view.listen()[Symbol.asyncIterator]();
    let heard = typed.next();
    let listening = true;
    let session = "";
    let inDraft = pr.isDraft;
    let paused = pr.isInMergeQueue;
    let state = pr.state;
    let rounds = 0;
    // The watch's first poll is only a baseline, so a pull request that was already open
    // carries threads nothing would ever report. The first round reads them instead.
    let pending: string[] = made.existed
      ? ["The pull request was already open before this run. Take whatever its threads still leave open."]
      : [];

    const opened = async (): Promise<string> => {
      if (session === "") session = await agent.open();
      return session;
    };

    const assessed = async (who: string, prompt: string): Promise<Assessment> =>
      narrated(view, () => agent.turn(who, { skill: "assess-feedback", prompt }, { result: Assessment }));

    const applied = async (who: string, heading: string, what: string): Promise<void> => {
      await narrated(view, () =>
        agent.turn(who, {
          skill: "address-feedback",
          prompt: `# Pull request\n\n${pr.url}\n\n# ${heading}\n\n${what}`,
        }),
      );
    };

    /** One round: assess, gate the plan, apply it, commit, gate the push. False ends the run. */
    const round = async (asks: string[]): Promise<boolean> => {
      const who = await opened();
      let plan = await assessed(
        who,
        `# Pull request\n\n${pr.url}\n\n# What arrived\n\n${asks.join("\n\n")}`,
      );

      for (;;) {
        if (plan.issues.length === 0) {
          await view.show(`Nothing on PR #${pr.number} is left to answer`);
          return true;
        }
        const answer = await view.ask(
          `${proposal(plan)}\n\nReply go to do this, skip to leave it, or say what to change about the plan.`,
          Go,
        );
        if (answer === "skip") {
          await view.show(`Round ${rounds} stays unanswered`);
          return true;
        }
        if (answer === "go") break;
        plan = await assessed(
          who,
          `The user says:\n\n${answer}\n\nAnswer it, adjust the assessment where the user is right, and return the whole thing again.`,
        );
      }

      await applied(who, "The approved plan", proposal(plan));

      // A fix asked for at the push gate writes another commit, so the gate keeps
      // the last title it wrote and asks again rather than dropping an unpushed commit.
      let message = "";
      for (;;) {
        const wrote = await call(ctx, commit, {});
        if (!wrote.ok) {
          await view.ask(`The commit failed: ${wrote.reason}`, Ack);
          return true;
        }
        if (wrote.committed) message = wrote.message.split("\n")[0] ?? "";
        else if (message === "") {
          await view.show("No code changed, so nothing goes up");
          return true;
        }
        const answer = await view.ask(
          `Committed: ${message}\n\nCheck it, then reply push to send it to PR #${pr.number}, hold to leave it here, or say what to fix first.`,
          Send,
        );
        if (answer === "push") return pushed();
        if (answer === "hold") {
          await view.show("The commit stays local. The next push carries it up.");
          return true;
        }
        await applied(who, "What to fix", answer);
      }
    };

    try {
      for (;;) {
        // Ahead of the feedback round, so an agent assessing feedback reads a branch that
        // already sits on the base it will land on.
        if (ahead !== "") {
          // The base moving is also what a merge of this pull request looks like, so what to do
          // with the move turns on a read of the pull request as it stands right now.
          const now = await github.pr.get(pr.url);
          if (!now.ok || now.pr === null) {
            ahead = "";
            await view.show(`${base} moved, but PR #${pr.number} did not read: ${now.reason}`);
            continue;
          }
          if (now.pr.state !== "OPEN") {
            state = now.pr.state;
            await view.show(`PR #${pr.number} is ${now.pr.state}`);
            break;
          }
          // This read is what the queue is, in and out of it. The changes watch reports only the
          // edge it polls across, and an entry that starts and ends between two polls has none.
          if (now.pr.isInMergeQueue !== paused) {
            paused = now.pr.isInMergeQueue;
            await view.show(
              paused
                ? `PR #${pr.number} is queued to merge, so the move on ${base} holds`
                : `PR #${pr.number} left the merge queue`,
            );
          }
          // The held move waits on the watch below, not on another read, so the gate cannot spin.
          if (!paused) {
            ahead = "";
            await followed();
            continue;
          }
        }

        if (pending.length > 0 && !inDraft && !paused) {
          rounds += 1;
          await view.show(`feedback round ${rounds}`);
          const asks = pending;
          pending = [];
          if (!(await round(asks))) break;
          continue;
        }

        await view.status(`watching PR #${pr.number}`, { idle: true });
        const arms: Promise<Woke>[] = [inbound.then(() => ({ kind: "change" }) as const)];
        if (listening) arms.push(heard.then(() => ({ kind: "said" }) as const));
        if (moving !== undefined) {
          arms.push(moving.then((move) => ({ kind: "moved", sha: move.sha }) as const));
        }
        const first = await Promise.race(arms);

        if (first.kind === "moved") {
          // Re-armed now, so the poll keeps running through the gate and the rebase it leads to.
          moving = based?.next();
          ahead = first.sha;
          continue;
        }

        if (first.kind === "said") {
          const message = await heard;
          if (message.done === true) {
            listening = false;
            continue;
          }
          heard = typed.next();
          pending.push(`The user says:\n\n${message.value.text}`);
          continue;
        }

        const change = await inbound;
        inbound = changes.next();
        if (change.kind === "closed") {
          state = change.state;
          await view.show(`PR #${pr.number} is ${change.state}`);
          break;
        }
        if (change.kind === "reviewed") {
          if (change.state === "APPROVED") {
            await view.show(`${change.author} approved PR #${pr.number}`);
            if (change.body === "") continue;
          }
          const said = change.body === "" ? "" : `:\n\n${change.body}`;
          pending.push(`${change.author} ${worded(change.state)}${said}`);
          continue;
        }
        if (change.kind === "comments") {
          pending.push(
            ...change.comments.map((note) => `${note.author} commented:\n\n${note.body}`),
          );
          continue;
        }
        if (change.kind === "draft") {
          inDraft = true;
          await view.show(`PR #${pr.number} went to draft, the watch holds`);
        }
        if (change.kind === "ready") {
          inDraft = false;
          await view.show(`PR #${pr.number} is ready for review again`);
        }
        if (change.kind === "queued") {
          paused = true;
          await view.show(`PR #${pr.number} is queued to merge, the watch holds`);
        }
        if (change.kind === "dequeued") {
          paused = false;
          await view.show(`PR #${pr.number} left the merge queue`);
        }
      }
    } finally {
      await typed.return?.(undefined);
    }

    return { url: pr.url, state, rounds };
  },
});
