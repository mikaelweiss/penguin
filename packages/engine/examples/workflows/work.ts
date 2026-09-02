import { call, workflow, type Ctx } from "penguin";
import { z } from "zod";
import { resolveBase } from "../helpers/base.ts";
import { resolveTicket } from "../helpers/ticket.ts";
import { narrated } from "../helpers/turns.ts";
import { openWorktree } from "../helpers/worktree.ts";
import commit from "./commit.ts";
import implement from "./implement.ts";
import { planOn } from "./plan.ts";
import { triageOn } from "./triage.ts";

const Ack = z.enum(["ok"]);
const Tried = z.union([z.enum(["done"]), z.string()]);

/** What git takes as a branch name, whatever the agent answered. */
function slug(name: string): string {
  const cut = name.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").slice(0, 50);
  const trimmed = cut.replaceAll(/^-+|-+$/g, "");
  return trimmed === "" ? "work" : trimmed;
}

const Lines = z.object({
  lines: z.array(z.string()).describe("one gate per line, in the syntax the gates skill describes"),
});
const Approved = z.union([z.enum(["approve"]), z.string()]);

/**
 * The project's gate file, found once and kept. A project that already lists its
 * gates costs no turn, and every run after the first reads what the person approved.
 */
async function settleGates(ctx: Ctx<unknown>): Promise<void> {
  if ((await ctx.gates.read()) !== undefined) return;
  const session = await ctx.agent.open();
  const found = await narrated(ctx.view, () =>
    ctx.agent.turn(session, { skill: "gates" }, { result: Lines }),
  );
  const proposed = found.lines.join("\n");
  const answer = await ctx.view.ask(
    `The quality gates for this project:\n\n${proposed}\n\nType approve, or the lines to keep instead.`,
    Approved,
  );
  await ctx.gates.write(answer === "approve" ? proposed : answer);
}

export default workflow({
  description: "triage a ticket, then plan and implement each task in a worktree",
  params: z.object({
    ticket: z
      .string()
      .describe("the ticket to work, as an id, a url, or the text itself")
      .meta({ multiline: true }),
    base: z
      .string()
      .default("main")
      .describe("the branch the work starts from, empty to take the one origin calls default"),
    rounds: z
      .number()
      .int()
      .min(1)
      .default(3)
      .describe("how many times the reviewer sends a change back before the run gives up"),
  }),

  async run(ctx) {
    const { params, agent, vcs, view } = ctx;
    const nothing = {
      done: false,
      path: "",
      branch: "",
      acceptance: "",
      gates: "",
      from: "",
      base: "",
    };

    // The base settles before any agent runs, so a branch nothing can start from costs no turn.
    const base = await resolveBase(ctx, params.base);
    if (base === "") return nothing;
    await vcs.fetch(base);

    // One session carries triage and every plan. The files triage read stay in the conversation,
    // so no plan reads them again and the second plan knows the first.
    // The session works in this run's checkout: the worktree has no name until triage answers.
    const session = await agent.open();
    const triaged = await triageOn(ctx, session, await resolveTicket(ctx, params.ticket));
    if (!triaged.actionable) {
      await view.ask(`Not actionable: ${triaged.reason}`, Ack);
      return nothing;
    }

    const branch = slug(triaged.branch);
    const dir = await openWorktree(ctx, branch, { from: `origin/${base}` });
    if (dir === "") return nothing;

    // The fresh worktree is the base, so what the gates say here is what every review compares against.
    const head = await vcs.head({ cwd: dir });
    await settleGates(ctx);
    const before = await ctx.gates.run({ cwd: dir });
    await view.show(before.green ? "baseline: green" : "baseline: already red");

    const checks: string[] = [];
    const total = triaged.tasks.length;
    for (const [index, task] of triaged.tasks.entries()) {
      await view.show(`task ${index + 1} of ${total}`);
      const planned = await planOn(ctx, session, task);
      checks.push(planned.acceptance);
      const built = await call(
        ctx,
        implement,
        {
          task: planned.plan,
          acceptance: planned.acceptance,
          baseline: before.report,
          base: head.sha,
          rounds: params.rounds,
        },
        { cwd: dir },
      );
      if (!built.approved)
        await view.ask(
          `The review did not approve the change:\n\n${built.blocking}\n\nTake a look.`,
          Ack,
        );
      await call(ctx, commit, {}, { cwd: dir });

      for (;;) {
        const answer = await view.ask(
          `Task ${index + 1} of ${total} is in ${dir}. Try it.\n\n${planned.acceptance}\n\nReply done, or say what to change.`,
          Tried,
        );
        if (answer === "done") break;
        await call(
          ctx,
          implement,
          {
            task: answer,
            acceptance: planned.acceptance,
            baseline: before.report,
            base: head.sha,
            rounds: params.rounds,
          },
          { cwd: dir },
        );
        await call(ctx, commit, {}, { cwd: dir });
      }
    }

    return {
      done: true,
      path: dir,
      branch,
      acceptance: checks.join("\n\n"),
      gates: before.report,
      from: head.sha,
      base,
    };
  },
});
