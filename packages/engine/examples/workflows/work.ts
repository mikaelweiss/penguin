import { call, workflow, type Ctx } from "penguin";
import { z } from "zod";
import { resolveBase } from "../helpers/base.ts";
import { resolveTicket } from "../helpers/ticket.ts";
import { narrated } from "../helpers/turns.ts";
import { openWorktree } from "../helpers/worktree.ts";
import commit from "./commit.ts";
import implement from "./implement.ts";
import plan from "./plan.ts";
import triage, { type Triaged } from "./triage.ts";
import walkthrough from "./walkthrough.ts";

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
    `The quality gates for this project:\n\n${proposed}\n\napprove keeps them. Anything else is the lines to keep instead.`,
    Approved,
  );
  await ctx.gates.write(answer === "approve" ? proposed : answer);
}

/** The split an earlier run settled, so continuing its branch costs no triage turn. */
function carried(branch: string, tasks: string[]): Triaged | undefined {
  if (branch === "" || tasks.length === 0) return undefined;
  return { actionable: true, reason: "", branch, tasks };
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
    branch: z
      .string()
      .default("")
      .describe("the branch to carry on with, empty to let triage name a new one")
      .meta({ internal: true }),
    tasks: z
      .array(z.string())
      .default([])
      .describe("the split to work, empty to let triage make one")
      .meta({ internal: true }),
    done: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("how many of the tasks are built already")
      .meta({ internal: true }),
    acceptance: z
      .string()
      .default("")
      .describe("what the tasks already built accept on, so the pull request states all of it")
      .meta({ internal: true }),
  }),

  async run(ctx) {
    const { params, vcs, view } = ctx;
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

    // Fetched once, so every stage after this reads the same ticket and none refetches it.
    const ticket = await resolveTicket(ctx, params.ticket);
    const triaged = carried(params.branch, params.tasks) ?? (await call(ctx, triage, { ticket }));
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

    const checks: string[] = params.acceptance === "" ? [] : [params.acceptance];
    let tasks = triaged.tasks;
    for (let index = params.done; index < tasks.length; index++) {
      await view.show(`task ${index + 1} of ${tasks.length}`);
      // Where this task starts, so its walkthrough reads this change and not the whole branch.
      const start = await vcs.head({ cwd: dir });
      const planned = await call(ctx, plan, { ticket, tasks, done: index }, { cwd: dir });
      // The planner reads the code, so the split it hands back is the one the run goes on with.
      tasks = planned.tasks;
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
        // The person reads a screen, not the acceptance: where to open it, what to do, what to expect.
        const tried = await call(
          ctx,
          walkthrough,
          { acceptance: planned.acceptance, base: start.sha },
          { cwd: dir },
        );
        const answer = await view.ask(
          `Task ${index + 1} of ${tasks.length} is in ${dir}. Try it.\n\n${tried.walkthrough}\n\ndone accepts it. Anything else says what to change.`,
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
