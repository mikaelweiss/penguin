import { call, workflow } from "penguin";
import { z } from "zod";
import { resolveBase } from "../helpers/base.ts";
import { narrated } from "../helpers/turns.ts";
import baseline from "./baseline.ts";
import commit from "./commit.ts";
import implement from "./implement.ts";
import plan from "./plan.ts";
import triage from "./triage.ts";

const Ack = z.enum(["ok"]);
const Tried = z.union([z.enum(["done"]), z.string()]);
const Named = z.object({
  branch: z.string().describe("the branch name, lowercase words with dashes between them"),
});

/** What git takes as a branch name, whatever the agent answered. */
function slug(name: string): string {
  const cut = name.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").slice(0, 50);
  const trimmed = cut.replaceAll(/^-+|-+$/g, "");
  return trimmed === "" ? "work" : trimmed;
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
    const fetched = await vcs.fetch(base);
    if (!fetched.ok) {
      await view.ask(`The fetch of ${base} failed: ${fetched.reason}`, Ack);
      return nothing;
    }

    const triaged = await call(ctx, triage, { ticket: ctx.params.ticket });
    if (!triaged.actionable) {
      await view.ask(`Not actionable: ${triaged.reason}`, Ack);
      return nothing;
    }

    const namer = await agent.open();
    const named = await narrated(view, () =>
      agent.turn(
        namer,
        {
          skill: "branch",
          prompt: `# Ticket\n\n${params.ticket}\n\n# What triage read\n\n${triaged.context}`,
        },
        { result: Named },
      ),
    );
    const branch = slug(named.branch);
    const ws = await vcs.worktree.add(branch, { from: `origin/${base}` });
    if (!ws.ok) {
      await view.ask(`No worktree: ${ws.reason}`, Ack);
      return nothing;
    }

    // The fresh worktree is the base, so what the gates say here is what every review compares against.
    const head = await vcs.head({ cwd: ws.path });
    const before = await call(ctx, baseline, {}, { cwd: ws.path });

    const checks: string[] = [];
    const total = triaged.tasks.length;
    for (const [index, task] of triaged.tasks.entries()) {
      await view.show(`task ${index + 1} of ${total}`);
      const planned = await call(
        ctx,
        plan,
        { ticket: task, context: triaged.context },
        { cwd: ws.path },
      );
      checks.push(planned.acceptance);
      const built = await call(
        ctx,
        implement,
        {
          task: planned.plan,
          acceptance: planned.acceptance,
          baseline: before.gates,
          base: head.sha,
          rounds: params.rounds,
        },
        { cwd: ws.path },
      );
      if (!built.approved)
        await view.ask(
          `The review did not approve the change:\n\n${built.blocking}\n\nTake a look.`,
          Ack,
        );
      await call(ctx, commit, {}, { cwd: ws.path });

      for (;;) {
        const answer = await view.ask(
          `Task ${index + 1} of ${total} is in ${ws.path}. Try it.\n\n${planned.acceptance}\n\nReply done, or say what to change.`,
          Tried,
        );
        if (answer === "done") break;
        await call(
          ctx,
          implement,
          {
            task: answer,
            acceptance: planned.acceptance,
            baseline: before.gates,
            base: head.sha,
            rounds: params.rounds,
          },
          { cwd: ws.path },
        );
        await call(ctx, commit, {}, { cwd: ws.path });
      }
    }

    return {
      done: true,
      path: ws.path,
      branch,
      acceptance: checks.join("\n\n"),
      gates: before.gates,
      from: head.sha,
      base,
    };
  },
});
